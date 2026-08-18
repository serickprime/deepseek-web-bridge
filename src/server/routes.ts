import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BridgeError, httpStatusForCode, safeErrorMessage } from "../utils/errors.js";
import type { Logger } from "../utils/logger.js";
import type { SecurityOptions } from "./middleware.js";
import { checkApiKey, corsAllowed, corsHeaders, isPublicPath, readBody } from "./middleware.js";
import type { CompletionHandler } from "../api/handler.js";
import type { Protocol } from "../api/normalizeByProtocol.js";
import { normalizeByProtocol } from "../api/normalizeByProtocol.js";
import { toOpenAIChat } from "./outputOpenAI.js";
import { toAnthropicMessage } from "./outputAnthropic.js";
import { toResponses } from "./outputResponses.js";
import { ProtocolStream } from "./protocolStream.js";
import type { SessionManager } from "../auth/sessionManager.js";
import type { Redactor } from "../utils/redaction.js";
import { LANDING_PAGE_HTML } from "./landingPage.js";
import { runAuthSSE, runDoctorSSE, runDiagnosticsSSE, checkAuthStatus, launchClaudeCode, launchOpenCode, writeSSE, endSSE, pickFolder, performLogout, stopLaunchedProcesses, type ActionEvent } from "./actions.js";

export interface RouteContext {
  security: SecurityOptions;
  handler: CompletionHandler;
  sessions: SessionManager;
  logger: Logger;
  redactor: Redactor;
  models: Array<{ id: string; object: string; owned_by: string }>;
  ready: () => boolean;
  gracefulStop?: () => Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string, contentType = "text/plain"): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function routeError(res: ServerResponse, error: unknown, ctx: RouteContext, requestRef: string): void {
  const logger = ctx.logger.withRequestRef(requestRef);
  if (error instanceof BridgeError) {
    logger.warn("route_error", { code: error.code, status: error.status, retryable: error.retryable });
  } else {
    logger.error("route_error_unhandled", { message: safeErrorMessage(error) });
  }
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  const status = error instanceof BridgeError ? error.status : 500;
  const code = error instanceof BridgeError ? error.code : "INTERNAL_ERROR";
  const message = error instanceof BridgeError ? error.message : "Internal server error";
  sendJson(res, status, { error: { type: code, message } });
}

function buildProtocolStream(
  protocol: Protocol,
  model: string,
  res: ServerResponse,
  streaming: boolean,
): ProtocolStream {
  if (streaming) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    return new ProtocolStream(protocol, model, chunk => res.write(chunk));
  }
  // Non-streaming: collect-only dummy that discards writes
  return new ProtocolStream(protocol, model, () => {});
}

function handleCompletion(ctx: RouteContext, protocol: Protocol, modelFallback: string) {
  return async (req: IncomingMessage, res: ServerResponse, requestRef: string): Promise<void> => {
    const logger = ctx.logger.withRequestRef(requestRef);
    try {
      const raw = await readBody({ raw: req }, ctx.security.maxBytes);
      const body = JSON.parse(raw.toString("utf8"));
      const normalized = normalizeByProtocol(protocol, body, req.headers as Record<string, string | undefined>);
      logger.info("completion_request", {
        protocol,
        model: normalized.model,
        stream: normalized.stream,
        tools: normalized.tools.length,
      });
      const stream = buildProtocolStream(protocol, normalized.model, res, normalized.stream);
      const runResult = await ctx.handler.run({
        protocol,
        request: normalized,
        headers: req.headers as Record<string, string | undefined>,
        body: body as Record<string, unknown>,
        stream,
      });
      if (!normalized.stream) {
        let payload: unknown;
        if (protocol === "openai") payload = toOpenAIChat(runResult.result, normalized.model);
        if (protocol === "anthropic") payload = toAnthropicMessage(runResult.result, normalized.model);
        if (protocol === "responses") payload = toResponses(runResult.result, normalized.model);
        sendJson(res, 200, payload);
      } else {
        res.end();
      }
      logger.info("completion_done", { upstream: runResult.upstreamKey });
    } catch (error) {
      if (res.writableEnded) return;
      routeError(res, error, ctx, requestRef);
    }
  };
}

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

const PUBLIC_ASSETS_DIR = resolve(process.cwd(), "public");

async function serveStaticAsset(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";
  const safePath = join(PUBLIC_ASSETS_DIR, pathname.replace(/^\//, ""));
  const resolved = resolve(safePath);
  if (!resolved.startsWith(PUBLIC_ASSETS_DIR)) {
    sendJson(res, 403, { error: { type: "FORBIDDEN", message: "Access denied" } });
    return;
  }
  try {
    const info = await stat(resolved);
    if (!info.isFile()) { sendJson(res, 404, { error: { type: "NOT_FOUND", message: "Not found" } }); return; }
    const ext = resolved.substring(resolved.lastIndexOf(".")).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    const data = await readFile(resolved);
    res.writeHead(200, { "content-type": contentType, "cache-control": "public, max-age=3600" });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: { type: "NOT_FOUND", message: "Not found" } });
  }
}

export function routes(ctx: RouteContext): Array<{
  method: string;
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse, requestRef: string) => Promise<void>;
}> {
  return [
    {
      method: "GET",
      path: "/",
      handler: async (_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(LANDING_PAGE_HTML);
      },
    },
    {
      method: "GET",
      path: "/health",
      handler: async (_req, res) => sendJson(res, 200, { status: "ok" }),
    },
    {
      method: "GET",
      path: "/readyz",
      handler: async (_req, res) => sendJson(res, ctx.ready() ? 200 : 503, { ready: ctx.ready() }),
    },
    {
      method: "GET",
      path: "/v1/models",
      handler: async (_req, res) => {
        const data = ctx.models.map(m => ({ ...m, created: Math.floor(Date.now() / 1000) }));
        sendJson(res, 200, { object: "list", data });
      },
    },
    {
      method: "POST",
      path: "/v1/chat/completions",
      handler: handleCompletion(ctx, "openai", "deepseek-chat"),
    },
    {
      method: "POST",
      path: "/v1/responses",
      handler: handleCompletion(ctx, "responses", "deepseek-chat"),
    },
    {
      method: "POST",
      path: "/v1/messages",
      handler: handleCompletion(ctx, "anthropic", "deepseek-chat"),
    },
    {
      method: "GET",
      path: "/v1/sessions",
      handler: async (_req, res) => {
        const list = ctx.sessions.listSessions().map(s => ({
          session_id: s.sessionId,
          created_at: s.createdAt,
          updated_at: s.updatedAt,
          name: s.name ?? null,
        }));
        sendJson(res, 200, { object: "list", data: list });
      },
    },
    {
      method: "POST",
      path: "/v1/sessions",
      handler: async (req, res) => {
        try {
          const raw = await readBody({ raw: req }, ctx.security.maxBytes);
          const body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
          const name = typeof body.name === "string" ? body.name.slice(0, 64) : undefined;
          const session = await ctx.sessions.addSession(makeId(), name);
          sendJson(res, 201, { object: "session", id: session.sessionId });
        } catch (error) {
          routeError(res, error, ctx, makeId());
        }
      },
    },
    {
      method: "DELETE",
      path: "/v1/sessions/:id",
      handler: async (req, res, requestRef) => {
        const id = (req.url ?? "").split("/").pop() ?? "";
        const removed = await ctx.sessions.removeSession(id);
        if (!removed) {
          sendJson(res, 404, { error: { type: "NOT_FOUND", message: "Session not found" } });
          return;
        }
        sendJson(res, 204, null);
      },
    },
    {
      method: "GET",
      path: "/bridge/auth-status",
      handler: async (_req, res) => {
        const status = await checkAuthStatus();
        sendJson(res, 200, status);
      },
    },
    {
      method: "POST",
      path: "/bridge/auth",
      handler: async (_req, res) => {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const send = (e: ActionEvent) => writeSSE(res, e);
        try {
          // Check if auth already exists and is valid
          const status = await checkAuthStatus();
          if (status.valid) {
            send({ type: "result", step: "auth", ok: true, message: "Auth already configured: " + status.message });
            endSSE(res);
            return;
          }
          await runAuthSSE(send);
        } catch (error) {
          send({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
        endSSE(res);
      },
    },
    {
      method: "POST",
      path: "/bridge/diagnostics",
      handler: async (_req, res) => {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const send = (e: ActionEvent) => writeSSE(res, e);
        try {
          await runDiagnosticsSSE(send);
        } catch (error) {
          send({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
        endSSE(res);
      },
    },
    {
      method: "POST",
      path: "/bridge/doctor",
      handler: async (_req, res) => {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const send = (e: ActionEvent) => writeSSE(res, e);
        try {
          await runDoctorSSE(send);
        } catch (error) {
          send({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
        endSSE(res);
      },
    },
    {
      method: "POST",
      path: "/bridge/launch",
      handler: async (req, res) => {
        try {
          const raw = await readBody({ raw: req }, ctx.security.maxBytes);
          const body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
          const tool = typeof body.tool === "string" ? body.tool : "";
          const workDir = typeof body.workDir === "string" ? body.workDir : process.cwd();
          const model = typeof body.model === "string" ? body.model : "deepseek-chat";

          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          const send = (e: ActionEvent) => writeSSE(res, e);

          if (tool === "claude") {
            launchClaudeCode(workDir, model, send);
          } else if (tool === "opencode") {
            launchOpenCode(workDir, model, send);
          } else {
            send({ type: "error", message: `Unknown tool: ${tool}. Use "claude" or "opencode".` });
            endSSE(res);
          }
        } catch (error) {
          sendJson(res, 500, { error: { type: "LAUNCH_ERROR", message: error instanceof Error ? error.message : String(error) } });
        }
      },
    },
    {
      method: "POST",
      path: "/bridge/pick-folder",
      handler: async (_req, res) => {
        const result = await pickFolder();
        if (!result.supported) {
          sendJson(res, 200, { path: null, message: "Folder picker not supported on this OS. Enter the path manually." });
        } else if (result.cancelled) {
          sendJson(res, 200, { path: null, cancelled: true });
        } else {
          sendJson(res, 200, { path: result.path });
        }
      },
    },
    {
      method: "POST",
      path: "/bridge/logout",
      handler: async (_req, res) => {
        await stopLaunchedProcesses();
        const result = await performLogout();
        if (!result.ok) {
          sendJson(res, 500, result);
          return;
        }
        sendJson(res, 200, result);
        setTimeout(async () => {
          await ctx.gracefulStop?.();
          process.exit(0);
        }, 500);
      },
    },
    {
      method: "POST",
      path: "/bridge/shutdown",
      handler: async (_req, res) => {
        sendJson(res, 200, { ok: true, message: "Bridge stopped." });
        await stopLaunchedProcesses();
        setTimeout(async () => {
          await ctx.gracefulStop?.();
          process.exit(0);
        }, 500);
      },
    },
    {
      method: "GET",
      path: "/assets/*",
      handler: serveStaticAsset,
    },
    {
      method: "OPTIONS",
      path: "*",
      handler: async (req, res) => {
        const origin = req.headers.origin;
        const headers = corsHeaders(origin, ctx.security);
        res.writeHead(204, headers);
        res.end();
      },
    },
  ];
}

export function middlewareWrapper(ctx: RouteContext) {
  return (req: IncomingMessage, res: ServerResponse, requestRef: string): boolean => {
    try {
      const origin = req.headers.origin;
      if (origin && !corsAllowed(origin, ctx.security)) {
        sendJson(res, 403, { error: { type: "CORS_DENIED", message: "Origin not allowed" } });
        return false;
      }
      for (const [name, value] of Object.entries(corsHeaders(origin, ctx.security))) {
        res.setHeader(name, value);
      }
      const pathname = (req.url ?? "/").split("?")[0] ?? "/";
      if (!isPublicPath(req.method ?? "GET", pathname)) {
        checkApiKey(req, ctx.security);
      }
      return true;
    } catch (error) {
      routeError(res, error, ctx, requestRef);
      return false;
    }
  };
}

export function errorStatus(error: unknown): number {
  if (error instanceof BridgeError) return error.status;
  return 500;
}
