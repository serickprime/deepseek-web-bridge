import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { CompletionHandler, type RunRequest, type RunResult } from "../../src/api/handler.js";
import type { CanonicalResult } from "../../src/api/canonical.js";
import type { DeepSeekClient } from "../../src/deepseek/client.js";
import type { LineageStore } from "../../src/sessions/lineage.js";
import { SessionStore } from "../../src/sessions/sessionStore.js";
import { routes, type RouteContext } from "../../src/server/routes.js";
import { ProtocolStream } from "../../src/server/protocolStream.js";
import { BridgeError } from "../../src/utils/errors.js";
import { Logger, type LogEntry } from "../../src/utils/logger.js";
import { Redactor } from "../../src/utils/redaction.js";

type Run = (input: RunRequest) => Promise<RunResult>;

interface HttpResult {
  status: number;
  contentType: string;
  body: string;
}

const ANTHROPIC_BODY = {
  model: "deepseek-v4-flash",
  max_tokens: 32,
  stream: true,
  messages: [{ role: "user", content: "test" }],
};

function result(content: string, toolCalls: CanonicalResult["toolCalls"] = []): RunResult {
  return {
    result: { content, toolCalls },
    upstreamKey: "upstream-test",
    streamed: true,
  };
}

function makeContext(run: Run, entries: LogEntry[] = []): RouteContext {
  const redactor = new Redactor({ secrets: ["secret-value-123"] });
  return {
    security: { proxyApiKey: "", corsOrigins: [], maxBytes: 64 * 1024, loopback: true },
    handler: { run } as CompletionHandler,
    sessions: {} as RouteContext["sessions"],
    logger: new Logger({ level: "debug", redactor, sinks: [entry => entries.push(entry)] }),
    redactor,
    models: [],
    ready: () => true,
  };
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function request(
  run: Run,
  options: {
    protocol?: "anthropic" | "openai" | "responses";
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
    entries?: LogEntry[];
  } = {},
): Promise<HttpResult> {
  const protocol = options.protocol ?? "anthropic";
  const path = protocol === "anthropic"
    ? "/v1/messages"
    : protocol === "openai"
      ? "/v1/chat/completions"
      : "/v1/responses";
  const ctx = makeContext(run, options.entries);
  const route = routes(ctx).find(item => item.method === "POST" && item.path === path)!;
  let routeFailure: unknown;
  const server = http.createServer((req, res) => {
    void route.handler(req, res, "d4-request-ref").catch(error => {
      routeFailure = error;
      if (!res.writableEnded) res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const body = JSON.stringify(options.body ?? ANTHROPIC_BODY);
  try {
    const response = await new Promise<HttpResult>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...options.headers,
        },
      }, res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(Buffer.from(chunk)));
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          contentType: String(res.headers["content-type"] ?? ""),
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      req.setTimeout(2_000, () => req.destroy(new Error("D4 test response timed out")));
      req.on("error", reject);
      req.end(body);
    });
    if (routeFailure) throw routeFailure;
    return response;
  } finally {
    await closeServer(server);
  }
}

function bridgeError(
  code: ConstructorParameters<typeof BridgeError>[1]["code"],
  status: number,
  options: Partial<ConstructorParameters<typeof BridgeError>[1]> = {},
): BridgeError {
  return new BridgeError(`unsafe ${code} secret-value-123`, { code, status, ...options });
}

describe("D4 Anthropic downstream error lifecycle", () => {
  it("D14: malformed top-level system blocks fail closed as Anthropic HTTP 400", async () => {
    const run = vi.fn(async () => result("must not run"));
    const response = await request(run, {
      body: {
        model: "deepseek-v4-flash",
        max_tokens: 32,
        stream: false,
        system: [
          { type: "text", text: "SYS-A" },
          { type: "image", source: { type: "base64", data: "not-used" } },
        ],
        messages: [{ role: "user", content: "test" }],
      },
    });

    expect(response.status).toBe(400);
    expect(response.contentType).toContain("application/json");
    expect(JSON.parse(response.body)).toMatchObject({
      type: "error",
      error: { type: "invalid_request_error" },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("T1: pre-start BridgeError is a real non-200 Anthropic JSON response", async () => {
    const ensureSession = vi.fn(async () => { throw bridgeError("UPSTREAM_ERROR", 502); });
    const complete = vi.fn(async () => ({ content: "should not run" }));
    const handler = new CompletionHandler({
      deepseek: { ensureSession, complete } as unknown as DeepSeekClient,
      sessionStore: new SessionStore(),
      lineage: {
        getUpstreamKey: () => undefined,
        record: vi.fn(async () => {}),
        removeByUpstreamKey: vi.fn(async () => {}),
      } as unknown as LineageStore,
      logger: new Logger({ sinks: [() => {}] }),
    });
    const response = await request(handler.run.bind(handler));
    expect(response.status).toBe(502);
    expect(response.contentType).toContain("application/json");
    expect(response.contentType).not.toContain("text/event-stream");
    expect(JSON.parse(response.body)).toEqual({
      type: "error",
      error: { type: "api_error", message: "Upstream request failed" },
    });
    expect(response.body).not.toContain("message_start");
    expect(ensureSession).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
  });

  it("T2: pre-start unknown Error is safe Anthropic HTTP 500", async () => {
    const response = await request(async () => { throw new Error("internal secret-value-123 C:\\private"); });
    expect(response.status).toBe(500);
    expect(JSON.parse(response.body)).toEqual({
      type: "error",
      error: { type: "api_error", message: "Internal server error" },
    });
    expect(response.body).not.toContain("secret-value-123");
    expect(response.body).not.toContain("C:\\private");
  });

  it("T3: timeout after message_start ends with timeout_error and no success terminal", async () => {
    const response = await request(async ({ stream }) => {
      stream.start();
      throw bridgeError("UPSTREAM_TIMEOUT", 504);
    });
    expect(response.status).toBe(200);
    expect(response.body).toContain("event: message_start");
    expect(response.body).toContain("event: error");
    expect(response.body).toContain('"type":"timeout_error"');
    expect(response.body).not.toContain("event: message_delta");
    expect(response.body).not.toContain("event: message_stop");
  });

  it("T4: STREAM_INCOMPLETE maps to api_error", async () => {
    const response = await request(async ({ stream }) => {
      stream.start();
      throw bridgeError("STREAM_INCOMPLETE", 502);
    });
    expect(response.body).toContain('"type":"api_error"');
    expect(response.body.match(/event: error/g)).toHaveLength(1);
  });

  it("T5: DeepSeek rate limit maps to rate_limit_error", async () => {
    const response = await request(async ({ stream }) => {
      stream.start();
      throw bridgeError("DEEPSEEK_RATE_LIMIT", 429);
    });
    expect(response.body).toContain('"type":"rate_limit_error"');
    expect(response.body).toContain('"message":"Upstream rate limit exceeded"');
  });

  it("T6: STREAM_PARSE_FAILED maps to api_error", async () => {
    const response = await request(async ({ stream }) => {
      stream.start();
      throw bridgeError("STREAM_PARSE_FAILED", 502);
    });
    expect(response.body).toContain('"type":"api_error"');
    expect(response.body).not.toContain("STREAM_PARSE_FAILED");
  });

  it("T7: UPSTREAM_ERROR maps to api_error", async () => {
    const response = await request(async ({ stream }) => {
      stream.start();
      throw bridgeError("UPSTREAM_ERROR", 502);
    });
    expect(response.body).toContain('"type":"api_error"');
    expect(response.body).toContain('"message":"Upstream request failed"');
  });

  it("T8: HTTP 401 maps to authentication_error", async () => {
    const response = await request(async ({ stream }) => {
      stream.start();
      throw bridgeError("DEEPSEEK_HTTP_401", 401);
    });
    expect(response.body).toContain('"type":"authentication_error"');
    expect(response.body).toContain('"message":"Authentication failed"');
  });

  it("T9: HTTP 403 maps to permission_error", async () => {
    const response = await request(async ({ stream }) => {
      stream.start();
      throw bridgeError("DEEPSEEK_HTTP_403", 403);
    });
    expect(response.body).toContain('"type":"permission_error"');
    expect(response.body).toContain('"message":"Permission denied"');
  });

  it("T10: partial text failure emits error without synthetic block or message terminal", async () => {
    const response = await request(async ({ stream }) => {
      stream.start();
      stream.push({ type: "content", text: "PARTIAL" });
      throw bridgeError("UPSTREAM_ERROR", 502);
    });
    expect(response.body).toContain('"text":"PARTIAL"');
    expect(response.body).toContain("event: error");
    expect(response.body).not.toContain("event: content_block_stop");
    expect(response.body).not.toContain("event: message_stop");
  });

  it("T11: unknown Error after start has a generic public message", async () => {
    const response = await request(async ({ stream }) => {
      stream.start();
      throw new Error("internal secret-value-123 C:\\private\\file");
    });
    expect(response.body).toContain('"type":"api_error"');
    expect(response.body).toContain('"message":"Internal server error"');
    expect(response.body).not.toContain("secret-value-123");
    expect(response.body).not.toContain("C:\\private");
  });

  it("T12: normal Anthropic text success lifecycle is unchanged", async () => {
    const response = await request(async ({ stream }) => {
      stream.start();
      stream.push({ type: "content", text: "SUCCESS" });
      stream.finish();
      return result("SUCCESS");
    });
    const order = ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"];
    let position = -1;
    for (const event of order) {
      const next = response.body.indexOf(`event: ${event}`, position + 1);
      expect(next).toBeGreaterThan(position);
      position = next;
    }
    expect(response.body).not.toContain("event: error");
  });

  it("T13: normal Anthropic tool_use success lifecycle is unchanged", async () => {
    const toolCall = { id: "call_ok", type: "function" as const, name: "Bash", arguments: { command: "pwd" } };
    const response = await request(async ({ stream }) => {
      stream.start();
      stream.push({ type: "tool_use", toolCall });
      stream.finish();
      return result("", [toolCall]);
    });
    expect(response.body).toContain('"type":"tool_use"');
    expect(response.body).toContain('"partial_json":"{\\"command\\":\\"pwd\\"}"');
    expect(response.body).toContain('"stop_reason":"tool_use"');
    expect(response.body).toContain("event: message_stop");
    expect(response.body).not.toContain("event: error");
  });

  it("required usage: non-stream Anthropic tool_use without exact upstream usage remains a valid Message", async () => {
    const toolCall = {
      id: "call_required_usage",
      type: "function" as const,
      name: "Write",
      arguments: { file_path: "compat.txt", content: "COMPAT" },
    };
    const response = await request(async () => result("", [toolCall]), {
      body: {
        model: "deepseek-v4-flash",
        max_tokens: 32,
        stream: false,
        messages: [{ role: "user", content: "Create the compatibility file." }],
        tools: [{ name: "Write", description: "write a file", input_schema: { type: "object" } }],
      },
    });
    const message = JSON.parse(response.body) as Record<string, unknown>;
    const usage = message.usage as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(message).toMatchObject({
      type: "message",
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "call_required_usage",
        name: "Write",
        input: { file_path: "compat.txt", content: "COMPAT" },
      }],
      stop_reason: "tool_use",
      stop_sequence: null,
    });
    expect(usage.input_tokens).toEqual(expect.any(Number));
    expect(usage.output_tokens).toEqual(expect.any(Number));
    expect(Number.isInteger(usage.input_tokens)).toBe(true);
    expect(Number.isInteger(usage.output_tokens)).toBe(true);
    expect(usage.input_tokens).toBeGreaterThan(0);
    expect(usage.output_tokens).toBeGreaterThan(0);
    expect(message).not.toHaveProperty("usage_source");
  });

  it("D15b: CompletionHandler propagates exact text usage only to the terminal Anthropic event", async () => {
    const handler = new CompletionHandler({
      deepseek: {
        ensureSession: vi.fn(async () => {}),
        complete: vi.fn(async () => ({
          content: "USAGE-TEXT",
          usage: { promptTokens: 21, completionTokens: 8, totalTokens: 29 },
        })),
      } as unknown as DeepSeekClient,
      sessionStore: new SessionStore(),
      lineage: {
        getUpstreamKey: () => undefined,
        record: vi.fn(async () => {}),
        removeByUpstreamKey: vi.fn(async () => {}),
      } as unknown as LineageStore,
      logger: new Logger({ sinks: [() => {}] }),
    });

    const response = await request(handler.run.bind(handler));
    const start = response.body.match(/event: message_start\ndata: ([^\n]+)/)?.[1] ?? "{}";
    const done = response.body.match(/event: message_delta\ndata: ([^\n]+)/)?.[1] ?? "{}";

    expect(JSON.parse(start).message).not.toHaveProperty("usage");
    expect(JSON.parse(done).usage).toEqual({ output_tokens: 8 });
    expect(response.body.match(/event: message_delta/g)).toHaveLength(1);
    expect(response.body.match(/event: message_stop/g)).toHaveLength(1);
  });

  it("D15b: CompletionHandler applies the same exact terminal usage semantics to tool_use", async () => {
    const handler = new CompletionHandler({
      deepseek: {
        ensureSession: vi.fn(async () => {}),
        complete: vi.fn(async () => ({
          content: "",
          toolCall: { name: "Bash", args: { command: "pwd" } },
          usage: { promptTokens: 18, completionTokens: 4, totalTokens: 22 },
        })),
      } as unknown as DeepSeekClient,
      sessionStore: new SessionStore(),
      lineage: {
        getUpstreamKey: () => undefined,
        record: vi.fn(async () => {}),
        removeByUpstreamKey: vi.fn(async () => {}),
      } as unknown as LineageStore,
      logger: new Logger({ sinks: [() => {}] }),
    });

    const response = await request(handler.run.bind(handler), {
      body: {
        ...ANTHROPIC_BODY,
        tools: [{ name: "Bash", description: "shell", input_schema: { type: "object" } }],
      },
    });
    const done = response.body.match(/event: message_delta\ndata: ([^\n]+)/)?.[1] ?? "{}";

    expect(response.body).toContain('"type":"tool_use"');
    expect(JSON.parse(done)).toMatchObject({
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 4 },
    });
    expect(response.body.match(/event: message_delta/g)).toHaveLength(1);
    expect(response.body.match(/event: message_stop/g)).toHaveLength(1);
  });

  it("T14: fail is idempotent", () => {
    const chunks: string[] = [];
    const stream = new ProtocolStream("anthropic", "m", chunk => chunks.push(chunk));
    stream.start();
    expect(stream.fail({ type: "api_error", message: "failed" })).toBe(true);
    expect(stream.fail({ type: "api_error", message: "again" })).toBe(false);
    expect(chunks.join("").match(/event: error/g)).toHaveLength(1);
  });

  it("T15: finish then fail emits success only", () => {
    const chunks: string[] = [];
    const stream = new ProtocolStream("anthropic", "m", chunk => chunks.push(chunk));
    stream.start();
    stream.finish();
    stream.finish();
    expect(stream.fail({ type: "api_error", message: "late" })).toBe(false);
    expect(chunks.join("")).toContain("event: message_stop");
    expect(chunks.join("").match(/event: message_stop/g)).toHaveLength(1);
    expect(chunks.join("")).not.toContain("event: error");
  });

  it("T16: fail then finish emits error only", () => {
    const chunks: string[] = [];
    const stream = new ProtocolStream("anthropic", "m", chunk => chunks.push(chunk));
    stream.start();
    stream.fail({ type: "api_error", message: "failed" });
    stream.finish();
    expect(chunks.join("")).toContain("event: error");
    expect(chunks.join("")).not.toContain("event: message_stop");
  });

  it("T17: push after either terminal emits no output", () => {
    for (const terminal of ["success", "error"] as const) {
      const chunks: string[] = [];
      const stream = new ProtocolStream("anthropic", "m", chunk => chunks.push(chunk));
      stream.start();
      if (terminal === "success") stream.finish();
      else stream.fail({ type: "api_error", message: "failed" });
      const before = chunks.length;
      stream.push({ type: "content", text: "AFTER" });
      expect(chunks).toHaveLength(before);
      expect(chunks.join("")).not.toContain("AFTER");
    }
  });

  it("T18: pre-start 401 and 403 preserve their HTTP statuses", async () => {
    const unauthorized = await request(async () => { throw bridgeError("DEEPSEEK_HTTP_401", 401); });
    const forbidden = await request(async () => { throw bridgeError("DEEPSEEK_HTTP_403", 403); });
    expect(unauthorized.status).toBe(401);
    expect(JSON.parse(unauthorized.body).error.type).toBe("authentication_error");
    expect(forbidden.status).toBe(403);
    expect(JSON.parse(forbidden.body).error.type).toBe("permission_error");
  });

  it("T19: mid-stream error keeps outer HTTP 200", async () => {
    const response = await request(async ({ stream }) => {
      stream.start();
      throw bridgeError("DEEPSEEK_RATE_LIMIT", 429);
    });
    expect(response.status).toBe(200);
    expect(response.contentType).toContain("text/event-stream");
  });

  it("T20: response closes boundedly after event:error", async () => {
    const startedAt = Date.now();
    const response = await request(async ({ stream }) => {
      stream.start();
      throw bridgeError("UPSTREAM_TIMEOUT", 504);
    });
    expect(response.body).toContain("event: error");
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });

  it("T21: lineage persistence failure occurs before tool exposure", async () => {
    const lineage = {
      getUpstreamKey: () => undefined,
      record: vi.fn(async () => { throw bridgeError("PERSISTENCE_ERROR", 500); }),
      removeByUpstreamKey: vi.fn(async () => {}),
    } as unknown as LineageStore;
    const handler = new CompletionHandler({
      deepseek: {
        ensureSession: vi.fn(async () => {}),
        complete: vi.fn(async () => ({
          content: "",
          toolCall: { name: "Bash", args: { command: "pwd" } },
        })),
      } as unknown as DeepSeekClient,
      sessionStore: new SessionStore(),
      lineage,
      logger: new Logger({ sinks: [() => {}] }),
    });
    const response = await request(handler.run.bind(handler), {
      body: {
        ...ANTHROPIC_BODY,
        tools: [{ name: "Bash", description: "shell", input_schema: { type: "object" } }],
      },
    });
    expect(response.body).toContain("event: message_start");
    expect(response.body).toContain("event: error");
    expect(response.body).not.toContain('"type":"tool_use"');
    expect(response.body).not.toContain("input_json_delta");
    expect(response.body).not.toContain('"stop_reason":"tool_use"');
    expect(response.body).not.toContain("event: message_stop");
  });

  it("T22: successful lineage records precede normal tool exposure", async () => {
    const sequence: string[] = [];
    const lineage = {
      getUpstreamKey: () => undefined,
      record: vi.fn(async (id: string) => { sequence.push(`persist:${id}`); }),
      removeByUpstreamKey: vi.fn(async () => {}),
    } as unknown as LineageStore;
    const handler = new CompletionHandler({
      deepseek: {
        ensureSession: vi.fn(async () => {}),
        complete: vi.fn(async () => ({ content: "", toolCall: { name: "Bash", args: { command: "pwd" } } })),
      } as unknown as DeepSeekClient,
      sessionStore: new SessionStore(),
      lineage,
      logger: new Logger({ sinks: [() => {}] }),
    });
    const chunks: string[] = [];
    const stream = new ProtocolStream("anthropic", "deepseek-v4-flash", chunk => {
      chunks.push(chunk);
      if (chunk.includes('"type":"tool_use"')) sequence.push("expose");
    });
    const requestBody = {
      model: "deepseek-v4-flash",
      stream: true,
      system: "",
      messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: "run pwd" }] }],
      tools: [{ name: "Bash", description: "shell", inputSchema: { type: "object" } }],
      reasoning: false,
      search: false,
    };
    await handler.run({
      protocol: "anthropic",
      request: requestBody,
      headers: { "x-call-id": "caller-id", "x-claude-code-session-id": "client-id" },
      body: { metadata: { user_id: "upstream-key" } },
      stream,
    });
    expect(sequence.filter(item => item.startsWith("persist:"))).toHaveLength(2);
    expect(sequence.at(-1)).toBe("expose");
    expect(chunks.join("")).toContain('"type":"tool_use"');
    expect(chunks.join("")).toContain("event: message_stop");
  });

  it("T23: route logs original BridgeError metadata exactly once", async () => {
    const entries: LogEntry[] = [];
    await request(async ({ stream }) => {
      stream.start();
      throw bridgeError("STREAM_INCOMPLETE", 502, {
        retryable: true,
        upstreamStage: "completion_body",
        causeCode: "eof_before_terminal",
      });
    }, { entries });
    const routeErrors = entries.filter(entry => entry.msg === "route_error");
    expect(routeErrors).toHaveLength(1);
    expect(routeErrors[0]?.fields).toMatchObject({
      code: "STREAM_INCOMPLETE",
      status: 502,
      retryable: true,
      upstream_stage: "completion_body",
      cause_code: "eof_before_terminal",
    });
  });

  it("T24: OpenAI normal streaming regression is unchanged", async () => {
    const response = await request(async ({ stream }) => {
      stream.start();
      stream.push({ type: "content", text: "OPENAI-OK" });
      stream.finish();
      return result("OPENAI-OK");
    }, {
      protocol: "openai",
      body: { model: "deepseek-v4-flash", stream: true, messages: [{ role: "user", content: "test" }] },
    });
    expect(response.status).toBe(200);
    expect(response.body).toContain("OPENAI-OK");
    expect(response.body).toContain("data: [DONE]");
    expect(response.body).not.toContain("event: error");
  });

  it("T25: Responses normal streaming regression is unchanged", async () => {
    const response = await request(async ({ stream }) => {
      stream.start();
      stream.push({ type: "content", text: "RESPONSES-OK" });
      stream.finish();
      return result("RESPONSES-OK");
    }, {
      protocol: "responses",
      body: {
        model: "deepseek-v4-flash",
        stream: true,
        input: [{ role: "user", content: [{ type: "input_text", text: "test" }] }],
      },
    });
    expect(response.status).toBe(200);
    expect(response.body).toContain("RESPONSES-OK");
    expect(response.body).toContain("event: response.completed");
    expect(response.body).not.toContain("event: error");
  });

  it("T26: disconnect does not cause an uncaught write or double terminal", async () => {
    let continueRun!: () => void;
    const resume = new Promise<void>(resolve => { continueRun = resolve; });
    let handlerCompleted!: () => void;
    const completed = new Promise<void>(resolve => { handlerCompleted = resolve; });
    const ctx = makeContext(async ({ stream }) => {
      stream.start();
      await resume;
      stream.push({ type: "content", text: "AFTER-DISCONNECT" });
      stream.finish();
      handlerCompleted();
      return result("AFTER-DISCONNECT");
    });
    const route = routes(ctx).find(item => item.path === "/v1/messages")!;
    const server = http.createServer((req, res) => {
      void route.handler(req, res, "disconnect-ref");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const body = JSON.stringify(ANTHROPIC_BODY);
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1",
          port,
          path: "/v1/messages",
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        }, res => {
          res.once("data", () => {
            res.destroy();
            resolve();
          });
        });
        req.on("error", reject);
        req.end(body);
      });
      continueRun();
      await Promise.race([
        completed,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("handler did not complete")), 1_000)),
      ]);
    } finally {
      continueRun();
      await closeServer(server);
    }
  });
});
