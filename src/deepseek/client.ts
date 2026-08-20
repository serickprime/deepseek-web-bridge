import {
  BROWSER_HEADERS,
  CHALLENGE_PATH,
  CLIENT_HEADERS,
  COMPLETION_PATH,
  SESSION_CREATE_PATH,
  UPSTREAM_USER_AGENT,
} from "../config/constants.js";
import { BridgeError } from "../utils/errors.js";
import type { Logger } from "../utils/logger.js";
import { collectAuthSecrets, type Redactor } from "../utils/redaction.js";
import { estimateTokenCount } from "../utils/tokenEstimate.js";
import type { CanonicalMessage, CanonicalRequest, CanonicalTool } from "../api/canonical.js";
import type { SessionManager } from "../auth/sessionManager.js";
import type { UpstreamSessionState } from "../sessions/sessionStore.js";
import { PowSolver, parseChallengePayload } from "./pow.js";
import { parseSseBlock, SseAccumulator } from "./sseParser.js";
import { DeepSeekPatchParser } from "./updateParser.js";
import { buildToolPrompt } from "../tools/toolPrompt.js";
import { SessionCreateLimiter } from "../utils/sessionCreateLimiter.js";
import {
  inspectToolCallFromOutput,
  createToolRetryPrompt,
  sanitizedToolInvocationText,
  toolResultText,
  looksLikeToolIntentText,
  looksLikeFakeToolTrace,
  inspectCurrentToolCycle,
  type CurrentToolCycleEvidence,
  COMPLETION_GUARD_MAX_ATTEMPTS,
  buildUpstreamPrompt,
} from "../tools/toolParser.js";
import { resolveModelSelection, type ModelSelection } from "../config/modelCapabilities.js";

export interface AuthCredentials {
  token: string;
  cookie: string;
  hifDliq?: string;
  hifLeim?: string;
}

export interface DeepSeekClientOptions {
  baseUrl: string;
  auth: AuthCredentials | null;
  sessionManager: SessionManager;
  solver: PowSolver;
  logger: Logger;
  redactor: Redactor;
  timeoutMs: number;
  maxRetries: number;
}

export interface CompletionCallbacks {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
}

export interface CompletionResult {
  parentMessageId: number | null;
  content: string;
  toolCall?: { name: string; args: Record<string, unknown> };
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

const MAX_COMPLETIONS = 2;

export class DeepSeekClient {
  private readonly sessionLimiter = new SessionCreateLimiter();
  private readonly options: DeepSeekClientOptions;
  private auth: AuthCredentials | null = null;
  private authGeneration = 0;

  constructor(options: DeepSeekClientOptions) {
    this.options = { ...options, auth: null };
    if (options.auth) this.setAuth(options.auth);
  }

  setAuth(auth: AuthCredentials): void {
    this.auth = { ...auth };
    this.authGeneration++;
    for (const secret of collectAuthSecrets(auth as unknown as Record<string, unknown>)) {
      this.options.redactor.addSecret(secret);
    }
  }

  clearAuth(): void {
    this.auth = null;
    this.authGeneration++;
  }

  hasAuth(): boolean {
    return this.auth !== null;
  }

  getAuthGeneration(): number {
    return this.authGeneration;
  }

  private assertAuthGeneration(expected: number): void {
    if (expected !== this.authGeneration) {
      throw new BridgeError("DeepSeek credentials changed while the request was running. Retry the request.", {
        code: "SESSION_CONFLICT",
        status: 409,
        retryable: true,
      });
    }
  }

  async ensureSession(state: UpstreamSessionState, authGeneration = this.authGeneration): Promise<void> {
    this.assertAuthGeneration(authGeneration);
    if (state.chatSessionId) return;
    await this.sessionLimiter.acquire();
    this.assertAuthGeneration(authGeneration);
    if (state.chatSessionId) return;
    const body = JSON.stringify({});
    const res = await this.fetch(SESSION_CREATE_PATH, { method: "POST", body }, null, authGeneration);
    if (res.status === 401 || res.status === 403) {
      throw new BridgeError(
        `DeepSeek authorization expired (HTTP ${res.status}). Use AUTH in Bridge Console, or run \`npm run auth\`.`,
        { code: res.status === 401 ? "DEEPSEEK_HTTP_401" : "DEEPSEEK_HTTP_403", status: res.status },
      );
    }
    if (!res.ok) {
      throw new BridgeError(`DeepSeek session creation HTTP ${res.status}`, { code: "UPSTREAM_ERROR", status: res.status });
    }
    const json = (await res.json()) as Record<string, unknown>;
    if (typeof json.code === "number" && json.code !== 0) {
      throw new BridgeError(`DeepSeek API error: ${json.code} ${json.msg ?? ""}`, { code: "UPSTREAM_ERROR" });
    }
    const data = json.data;
    if (!data || typeof data !== "object") {
      throw new BridgeError("Session creation failed: missing data", { code: "UPSTREAM_ERROR" });
    }
    const dataRecord = data as Record<string, unknown>;
    if (typeof dataRecord.biz_code === "number" && dataRecord.biz_code !== 0) {
      throw new BridgeError(`DeepSeek business error: ${dataRecord.biz_code} ${dataRecord.biz_msg ?? ""}`, { code: "UPSTREAM_ERROR" });
    }
    const bizData = (dataRecord.biz_data && typeof dataRecord.biz_data === "object")
      ? dataRecord.biz_data as Record<string, unknown>
      : dataRecord;
    let id: unknown;
    if (bizData.chat_session && typeof bizData.chat_session === "object") {
      id = (bizData.chat_session as Record<string, unknown>).id;
    }
    if (!id) id = bizData.id;
    if (typeof id !== "string" || !id) {
      throw new BridgeError("Session creation returned no id.", { code: "UPSTREAM_ERROR" });
    }
    this.assertAuthGeneration(authGeneration);
    state.chatSessionId = id;
  }

  async complete(
    request: CanonicalRequest,
    state: UpstreamSessionState,
    callbacks: CompletionCallbacks = {},
    authGeneration = this.authGeneration,
  ): Promise<CompletionResult> {
    this.assertAuthGeneration(authGeneration);
    const modelSelection = resolveModelSelection(request.model, request.reasoning, request.search);
    const toolPrompt = buildToolPrompt(request.tools);
    const allowedNames = request.tools.map(t => t.name);
    const hasTools = allowedNames.length > 0;
    const guardEvidence = inspectCurrentToolCycle(request.messages, allowedNames);

    const upstreamPrompt = this.buildPrompt(request, toolPrompt);
    let output = await this.runCompletion(upstreamPrompt, state, authGeneration, modelSelection);

    const inspection = inspectToolCallFromOutput(output, allowedNames);
    let toolCall = inspection.toolCall;

    // Bounded completion guard loop: retry when the current user turn requires
    // real environment evidence but has no current-cycle tool_result, or when
    // the model produces intent/fabricated tool text instead of tool_call JSON.
    let retries = 0;
    while (shouldRetry(hasTools, toolCall, output.content, output.reasoning, allowedNames, guardEvidence) && retries < COMPLETION_GUARD_MAX_ATTEMPTS - 1) {
      retries++;
      const retryPrompt = createToolRetryPrompt(allowedNames);
      output = await this.runCompletion(retryPrompt, state, authGeneration, modelSelection);
      const retryInspection = inspectToolCallFromOutput(output, allowedNames);
      toolCall = retryInspection.toolCall;
      if (toolCall) {
        output = { ...output, content: "", reasoning: "" };
      }
    }

    if (shouldRetry(hasTools, toolCall, output.content, output.reasoning, allowedNames, guardEvidence)) {
      this.options.logger.warn("completion_guard_rejected", {
        attempts: retries + 1,
        requires_environment_tool_result: guardEvidence.requiresEnvironmentToolResult,
        has_current_tool_result: guardEvidence.hasCurrentToolResult,
      });
      throw new BridgeError(
        "DeepSeek did not produce a real tool call. Environment data was not verified, so no fabricated command or file result was returned.",
        { code: "TOOL_CALL_REQUIRED", status: 502, retryable: true },
      );
    }

    if (toolCall) {
      callbacks.onToolCall?.(toolCall.name, toolCall.arguments as Record<string, unknown>);
    }

    this.assertAuthGeneration(authGeneration);
    return {
      parentMessageId: state.parentMessageId,
      content: toolCall ? "" : output.content,
      toolCall: toolCall ? { name: toolCall.name, args: toolCall.arguments as Record<string, unknown> } : undefined,
      usage: output.usage,
    };
  }

  private async runCompletion(
    prompt: string,
    state: UpstreamSessionState,
    authGeneration: number,
    model: ModelSelection,
  ): Promise<{ content: string; reasoning: string; parentMessageId: number | null; usage?: CompletionResult["usage"] }> {
    const payload = {
      chat_session_id: state.chatSessionId,
      parent_message_id: state.parentMessageId,
      prompt,
      ref_file_ids: [],
      model_type: model.upstreamModelType,
      thinking_enabled: model.thinkingEnabled,
      search_enabled: model.searchEnabled,
      action: null,
      preempt: false,
    };
    const challenge = await this.fetchChallenge(authGeneration);
    const solution = await this.options.solver.solve(challenge);
    const res = await this.fetch(
      COMPLETION_PATH,
      { method: "POST", body: JSON.stringify(payload) },
      solution,
      authGeneration,
    );
    if (res.status === 401 || res.status === 403) {
      throw new BridgeError(
        `DeepSeek authorization expired (HTTP ${res.status}). Use AUTH in Bridge Console, or run \`npm run auth\`.`,
        { code: res.status === 401 ? "DEEPSEEK_HTTP_401" : "DEEPSEEK_HTTP_403", status: res.status },
      );
    }
    if (!res.ok) {
      let errorBody = "";
      try {
        if (res.body) {
          const reader = res.body.getReader();
          const { value } = await reader.read();
          errorBody = value ? new TextDecoder().decode(value) : "";
        }
      } catch {}
      this.options.logger.warn("upstream_error_response", {
        status: res.status,
        body: errorBody.slice(0, 500),
        prompt_bytes: Buffer.byteLength(payload.prompt, "utf8"),
      });
      throw new BridgeError(`Upstream error HTTP ${res.status}: ${errorBody.slice(0, 200)}`, { code: "UPSTREAM_ERROR", status: res.status, retryable: true });
    }
    if (res.body === null) {
      throw new BridgeError("Empty upstream body.", { code: "STREAM_PARSE_FAILED" });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const accumulator = new SseAccumulator();
    const parser = new DeepSeekPatchParser();
    let parentMessageId: number | null = null;
    let content = "";
    let reasoning = "";
    let usage: CompletionResult["usage"];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const raw = decoder.decode(value, { stream: true });
      if (raw.trimStart().startsWith("{")) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.code === "number") {
            const bizCode = parsed.data?.biz_code;
            if (parsed.code !== 0 || (typeof bizCode === "number" && bizCode !== 0)) {
              const msg = parsed.msg || parsed.data?.biz_msg || "unknown";
              throw new BridgeError(`Upstream API error: ${msg}`, {
                code: "UPSTREAM_ERROR", retryable: true,
              });
            }
          }
        } catch (e) {
          if (e instanceof BridgeError) throw e;
        }
      }
      const events = accumulator.push(raw);
      for (const event of events) {
        if (event.type === "update") {
          const chunk = parser.apply(event.data);
          if (!chunk) continue;
          if (chunk.messageId) state.parentMessageId = chunk.messageId;
          if (chunk.parentMessageId) parentMessageId = chunk.parentMessageId;
          if (chunk.reasoningDelta) reasoning += chunk.reasoningDelta;
          if (chunk.delta) content += chunk.delta;
          if (chunk.done) {
            if (chunk.usage) usage = chunk.usage;
            break;
          }
        }
      }
    }
    const trailing = accumulator.flush();
    for (const event of trailing) {
      if (event.type === "update") {
        const chunk = parser.apply(event.data);
        if (chunk?.usage) usage = chunk.usage;
      }
    }

    return { content, reasoning, parentMessageId, usage };
  }

  private buildPrompt(
    request: CanonicalRequest,
    toolPrompt: string,
  ): string {
    const parts: string[] = [];
    if (request.system) parts.push(`System: ${request.system}`);
    if (toolPrompt) parts.push(toolPrompt);

    // Use FreeDeepseekAPI-style message formatting (system handled inside buildUpstreamPrompt for anthropic)
    const kind = this.detectProtocol(request);
    const prompt = buildUpstreamPrompt(
      { messages: this.canonicalToRaw(request.messages) },
      kind,
      null,
    );
    if (prompt) parts.push(prompt);

    return parts.filter(Boolean).join("\n\n") || "continue";
  }

  private detectProtocol(request: CanonicalRequest): string {
    // If messages have Anthropic-style tool_use/tool_result parts, use anthropic
    for (const msg of request.messages) {
      for (const part of msg.parts) {
        if (part.type === "tool_use" || part.type === "tool_result") return "anthropic";
      }
    }
    return "openai";
  }

  private canonicalToRaw(messages: CanonicalMessage[]): Record<string, unknown>[] {
    const toolNameById = buildToolUseIdMap(messages);
    return messages.map(msg => {
      const parts: string[] = [];
      for (const part of msg.parts) {
        if (part.type === "text") {
          parts.push(part.text ?? "");
        } else if (part.type === "tool_use") {
          parts.push(sanitizedToolInvocationText(
            part.toolCall?.name ?? "",
            part.toolCall?.id ?? "",
          ));
        } else if (part.type === "tool_result") {
          const toolUseId = part.toolResult?.toolUseId ?? "";
          const toolName = toolNameById.get(toolUseId) ?? "unknown";
          parts.push(toolResultText(
            toolName,
            toolUseId,
            part.toolResult?.content ?? "",
          ));
        }
      }
      return {
        role: msg.role,
        content: parts.filter(Boolean).join("\n"),
      };
    });
  }

  private async fetchChallenge(authGeneration: number): Promise<ReturnType<typeof parseChallengePayload> & { expireAt: number }> {
    const body = JSON.stringify({ target_path: COMPLETION_PATH });
    const res = await this.fetch(CHALLENGE_PATH, { method: "POST", body }, null, authGeneration);
    if (res.status === 401 || res.status === 403) {
      throw new BridgeError(
        `DeepSeek authorization expired (HTTP ${res.status}). Use AUTH in Bridge Console, or run \`npm run auth\`.`,
        { code: res.status === 401 ? "DEEPSEEK_HTTP_401" : "DEEPSEEK_HTTP_403", status: res.status },
      );
    }
    const json = (await res.json()) as Record<string, unknown>;
    const challenge = parseChallengePayload(json);
    if (!challenge) {
      throw new BridgeError("PoW challenge payload changed.", { code: "POW_FORMAT_CHANGED" });
    }
    return challenge;
  }

  private async fetch(
    path: string,
    init: { method: string; body?: string },
    solution: { answer: number; signature: string; algorithm: string; salt: string; challenge: string } | null,
    authGeneration = this.authGeneration,
  ): Promise<Response> {
    this.assertAuthGeneration(authGeneration);
    const { baseUrl, timeoutMs, maxRetries, logger, redactor } = this.options;
    const auth = this.auth;
    if (!auth || (!auth.token && !auth.cookie)) {
      throw new BridgeError("DeepSeek credentials are not configured. Use AUTH in Bridge Console.", {
        code: "AUTH_MISSING",
        status: 401,
      });
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...CLIENT_HEADERS,
      ...BROWSER_HEADERS,
      "user-agent": UPSTREAM_USER_AGENT,
      authorization: `Bearer ${auth.token}`,
      cookie: auth.cookie,
    };
    if (auth.hifLeim) headers["x-hif-leim"] = auth.hifLeim;
    if (auth.hifDliq) headers["x-hif-dliq"] = auth.hifDliq;
    if (solution) {
      const powJson = JSON.stringify({
        algorithm: solution.algorithm,
        challenge: solution.challenge,
        salt: solution.salt,
        answer: solution.answer,
        signature: solution.signature,
        target_path: COMPLETION_PATH,
      });
      headers["x-ds-pow-response"] = Buffer.from(powJson).toString("base64");
    }
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      this.assertAuthGeneration(authGeneration);
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method: init.method,
          headers,
          body: init.body,
          signal: controller.signal,
        });
        this.assertAuthGeneration(authGeneration);
        return res;
      } catch (error) {
        lastError = error;
        const retryable = !(error instanceof BridgeError);
        logger?.warn("upstream_fetch_retry", {
          path: redactor.redactText(path),
          attempt: attempt + 1,
          retryable,
        });
        if (!retryable) throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    const aborted = lastError instanceof Error && lastError.name === "AbortError";
    throw new BridgeError(aborted ? "Upstream request timed out." : "Upstream request failed.", {
      code: aborted ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR",
      status: aborted ? 504 : 502,
      retryable: true,
    });
  }

  estimatePromptTokens(request: CanonicalRequest): number {
    let total = 0;
    for (const message of request.messages) {
      for (const part of message.parts) {
        if (part.text) total += estimateTokenCount(part.text);
        if (part.toolResult?.content) total += estimateTokenCount(part.toolResult.content);
      }
    }
    if (request.system) total += estimateTokenCount(request.system);
    return total;
  }
}

export function shouldRetry(
  hasTools: boolean,
  toolCall: unknown,
  content: string,
  reasoning: string,
  allowedToolNames: string[] = [],
  evidence?: CurrentToolCycleEvidence,
): boolean {
  if (!hasTools || toolCall) return false;
  if (evidence?.hasCurrentToolResult) return false;
  if (evidence?.requiresEnvironmentToolResult) return true;
  if (content.trim() === "" && reasoning.trim() !== "") return true;
  if (content.trim() !== "" && looksLikeToolIntentText(content, allowedToolNames)) return true;
  if (content.trim() !== "" && looksLikeFakeToolTrace(content, allowedToolNames)) return true;
  return false;
}

export function buildToolNames(tools: CanonicalTool[]): Set<string> {
  return new Set(tools.map(tool => tool.name));
}

export function toolsToCanonical(tools: CanonicalTool[]): CanonicalTool[] {
  return tools;
}

export function buildToolUseIdMap(messages: CanonicalMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool_use" && part.toolCall?.id && part.toolCall?.name) {
        map.set(part.toolCall.id, part.toolCall.name);
      }
    }
  }
  return map;
}
