import { afterEach, describe, expect, it, vi } from "vitest";
import { CompletionHandler } from "../../src/api/handler.js";
import type { CanonicalMessage, CanonicalRequest } from "../../src/api/canonical.js";
import { DeepSeekClient } from "../../src/deepseek/client.js";
import type { LineageStore } from "../../src/sessions/lineage.js";
import { SessionStore, type UpstreamSessionState } from "../../src/sessions/sessionStore.js";
import type { ProtocolStream } from "../../src/server/protocolStream.js";
import { routes, type RouteContext } from "../../src/server/routes.js";
import { BridgeError } from "../../src/utils/errors.js";
import { Logger, type LogEntry } from "../../src/utils/logger.js";
import { Redactor } from "../../src/utils/redaction.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const CHALLENGE = {
  code: 0,
  data: {
    biz_code: 0,
    biz_data: {
      challenge: {
        target_path: "/api/v0/chat/completion",
        signature: "signature-value",
        salt: "salt-value",
        challenge: "challenge-value",
        algorithm: "DeepSeekHashV1",
        difficulty: 1,
        expire_at: Date.now() + 60_000,
      },
    },
  },
};

const BASH = {
  name: "Bash",
  description: "Run a shell command",
  inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};

function entriesLogger(entries: LogEntry[], level: "debug" | "info" | "warn" | "error" = "debug"): Logger {
  return new Logger({ level, redactor: new Redactor(), sinks: [entry => entries.push(entry)] });
}

function request(messages: CanonicalMessage[], tools = [BASH]): CanonicalRequest {
  return {
    model: "deepseek-v4-flash",
    stream: false,
    system: "",
    messages,
    tools,
  };
}

function instruction(text = "Run pwd using Bash."): CanonicalMessage {
  return { role: "user", parts: [{ type: "text", text }] };
}

function state(chatSessionId = "chat-raw-id"): UpstreamSessionState {
  return { chatSessionId, parentMessageId: null, history: [], updatedAt: 0 };
}

function streamStub(): ProtocolStream {
  return {
    start: vi.fn(),
    push: vi.fn(),
    finish: vi.fn(),
    fail: vi.fn(),
  } as unknown as ProtocolStream;
}

function memoryLineage(seed: Record<string, string> = {}): LineageStore {
  const links = new Map(Object.entries(seed));
  return {
    getUpstreamKey: (id: string) => links.get(id),
    record: vi.fn(async (id: string, upstream: string) => { links.set(id, upstream); }),
    removeByUpstreamKey: vi.fn(async (upstream: string) => {
      for (const [id, value] of links) if (value === upstream) links.delete(id);
    }),
  } as unknown as LineageStore;
}

function completionSse(content: string, messageId = 2): Response {
  const body = `data: ${JSON.stringify({
    v: { response: { message_id: messageId, fragments: [{ type: "RESPONSE", content }], status: "FINISHED" } },
  })}\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function observedClient(entries: LogEntry[], outputs: Array<string | BridgeError>): DeepSeekClient {
  const logger = entriesLogger(entries);
  const client = new DeepSeekClient({
    baseUrl: "https://chat.deepseek.com",
    auth: { token: "synthetic-token", cookie: "synthetic-cookie" },
    sessionManager: {} as never,
    solver: {} as never,
    logger,
    redactor: logger.redactor,
    timeoutMs: 100,
    maxRetries: 0,
  });
  const queue = [...outputs];
  Object.defineProperty(client, "runCompletion", {
    value: vi.fn(async () => {
      const next = queue.shift();
      if (next instanceof BridgeError) throw next;
      if (next === undefined) throw new Error("No observed output left");
      return { content: next, reasoning: "", candidateMessageId: 2 };
    }),
  });
  return client;
}

describe("D8 safe request correlation telemetry", () => {
  it("preserves configured levels through withRequestRef and child", () => {
    const entries: LogEntry[] = [];
    const logger = entriesLogger(entries, "warn").withRequestRef("req-level").child({ stage: "test" });
    logger.debug("hidden_debug");
    logger.info("hidden_info");
    logger.warn("visible_warn");
    expect(entries.map(entry => entry.msg)).toEqual(["visible_warn"]);
    expect(entries[0]?.request_ref).toBe("req-level");
  });

  it("keeps opaque refs stable per process and separates domains", () => {
    const logger = entriesLogger([]);
    const first = logger.opaqueRef("client", "same-raw-value");
    expect(first).toBe(logger.withRequestRef("req").opaqueRef("client", "same-raw-value"));
    expect(first).toBe(logger.child({ stage: "test" }).opaqueRef("client", "same-raw-value"));
    expect(first).toBe(entriesLogger([]).opaqueRef("client", "same-raw-value"));
    expect(first).not.toBe(logger.opaqueRef("upstream", "same-raw-value"));
    expect(first).toMatch(/^client_[a-f0-9]{12}$/);
  });

  it("propagates one request_ref through handler, DeepSeek transport, and PoW without SSE chunk logs", async () => {
    const entries: LogEntry[] = [];
    const rootLogger = entriesLogger(entries);
    const scoped = rootLogger.withRequestRef("req-normal");
    scoped.info("request_start", { stage: "server" });
    scoped.info("completion_request", { stage: "request_normalized" });
    globalThis.fetch = vi.fn(async input => {
      const url = String(input);
      if (url.endsWith("/api/v0/chat_session/create")) {
        return new Response(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: { chat_session: { id: "chat-sensitive-id" } } } }), { status: 200 });
      }
      if (url.endsWith("/api/v0/chat/create_pow_challenge")) {
        return new Response(JSON.stringify(CHALLENGE), { status: 200 });
      }
      if (url.endsWith("/api/v0/chat/completion")) return completionSse("SAFE-OK");
      throw new Error("unexpected transport");
    }) as typeof globalThis.fetch;
    const deepseek = new DeepSeekClient({
      baseUrl: "https://chat.deepseek.com",
      auth: { token: "token-never-log", cookie: "cookie-never-log" },
      sessionManager: {} as never,
      solver: {
        solve: async (_challenge: unknown, logger: Logger) => {
          logger.info("pow_solved", { stage: "pow_solve", outcome: "success", latency_ms: 1 });
          return { answer: 1, signature: "signature-value", algorithm: "DeepSeekHashV1", salt: "salt-value", challenge: "challenge-value" };
        },
      } as never,
      logger: rootLogger,
      redactor: rootLogger.redactor,
      timeoutMs: 1_000,
      maxRetries: 0,
    });
    const handler = new CompletionHandler({ deepseek, sessionStore: new SessionStore(), lineage: memoryLineage(), logger: rootLogger });
    const result = await handler.run({
      protocol: "anthropic",
      request: request([instruction("Sensitive prompt C:\\private\\project")], []),
      headers: { "x-claude-code-session-id": "raw-client-id" },
      body: { user: "raw-upstream-id" },
      stream: streamStub(),
      logger: scoped,
    });
    expect(result.result.content).toBe("SAFE-OK");
    const correlated = entries.filter(entry => [
      "request_start", "completion_request", "request_identity", "completion_attempt_start", "pow_solved", "completion_attempt_done",
    ].includes(entry.msg));
    expect(correlated.length).toBeGreaterThanOrEqual(6);
    expect(new Set(correlated.map(entry => entry.request_ref))).toEqual(new Set(["req-normal"]));
    expect(entries.some(entry => /sse.*chunk|chunk.*sse/i.test(entry.msg))).toBe(false);
    const serialized = JSON.stringify(entries);
    for (const raw of ["raw-client-id", "raw-upstream-id", "chat-sensitive-id", "Sensitive prompt", "C:\\private\\project", "token-never-log", "cookie-never-log"]) {
      expect(serialized).not.toContain(raw);
    }
    expect(serialized).toContain("client_ref");
    expect(serialized).toContain("upstream_ref");
    expect(serialized).toContain("chat_ref");
  });

  it("correlates selected/exposed tool and its linked tool_result using call_ref only", async () => {
    const entries: LogEntry[] = [];
    const logger = entriesLogger(entries).withRequestRef("req-tool");
    const lineage = memoryLineage();
    const outputs = [
      { content: "", toolCall: { name: "Bash", args: { command: "pwd-secret-arg" } } },
      { content: "done" },
    ];
    const deepseek = {
      getAuthGeneration: () => 0,
      ensureSession: vi.fn(async (session: UpstreamSessionState) => { session.chatSessionId ??= "chat-tool"; }),
      complete: vi.fn(async () => outputs.shift()!),
    } as unknown as DeepSeekClient;
    const handler = new CompletionHandler({ deepseek, sessionStore: new SessionStore(), lineage, logger });
    const firstStream = streamStub();
    await handler.run({
      protocol: "anthropic",
      request: request([instruction()]),
      headers: { "x-claude-code-session-id": "client-tool" },
      body: { user: "upstream-tool" },
      stream: firstStream,
      logger,
    });
    const exposed = (firstStream.push as ReturnType<typeof vi.fn>).mock.calls.find(call => call[0]?.type === "tool_use")?.[0];
    const callId = exposed.toolCall.id as string;
    await handler.run({
      protocol: "anthropic",
      request: request([
        instruction(),
        { role: "assistant", parts: [{ type: "tool_use", toolCall: exposed.toolCall }] },
        { role: "user", parts: [{ type: "tool_result", toolResult: { toolUseId: callId, content: "raw-tool-result" } }] },
      ]),
      headers: { "x-claude-code-session-id": "client-tool" },
      body: {},
      stream: streamStub(),
      logger,
    });
    const names = entries.map(entry => entry.msg);
    expect(names).toContain("tool_selected");
    expect(names).toContain("tool_exposed");
    expect(names).toContain("tool_result_continuation");
    expect(entries.find(entry => entry.msg === "tool_result_continuation")?.fields.outcome).toBe("linked");
    expect(new Set(entries.filter(entry => entry.msg === "request_identity").map(entry => entry.fields.upstream_ref)).size).toBe(1);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(callId);
    expect(serialized).not.toContain("pwd-secret-arg");
    expect(serialized).not.toContain("raw-tool-result");
    expect(serialized).toContain("call_ref");
    expect(entries.filter(entry => names.includes(entry.msg)).every(entry => entry.request_ref === "req-tool")).toBe(true);
  });

  it("logs SESSION_CONFLICT as a typed failure without raw lineage IDs", async () => {
    const entries: LogEntry[] = [];
    const logger = entriesLogger(entries).withRequestRef("req-conflict");
    const handler = new CompletionHandler({
      deepseek: {} as DeepSeekClient,
      sessionStore: new SessionStore(),
      lineage: memoryLineage({ "header-raw": "upstream-a-raw", "result-raw": "upstream-b-raw" }),
      logger,
    });
    await expect(handler.run({
      protocol: "anthropic",
      request: request([
        instruction(),
        { role: "assistant", parts: [{ type: "tool_use", toolCall: { id: "result-raw", type: "function", name: "Bash", arguments: { command: "pwd" } } }] },
        { role: "user", parts: [{ type: "tool_result", toolResult: { toolUseId: "result-raw", content: "out" } }] },
      ]),
      headers: { "x-call-id": "header-raw" },
      body: {},
      stream: streamStub(),
      logger,
    })).rejects.toMatchObject({ code: "SESSION_CONFLICT" });
    expect(entries.find(entry => entry.msg === "session_conflict")).toMatchObject({
      request_ref: "req-conflict",
      fields: { stage: "identity_resolution", failure_class: "SESSION_CONFLICT" },
    });
    expect(JSON.stringify(entries)).not.toMatch(/header-raw|result-raw|upstream-[ab]-raw/);
  });

  it("does not log arbitrary unhandled route error messages", async () => {
    const entries: LogEntry[] = [];
    const logger = entriesLogger(entries);
    const redactor = logger.redactor;
    const ctx: RouteContext = {
      security: { proxyApiKey: "", corsOrigins: [], maxBytes: 64 * 1024, loopback: true },
      handler: {
        run: async () => { throw new Error("synthetic-token C:\\private\\prompt raw-body"); },
      } as unknown as CompletionHandler,
      sessions: {} as RouteContext["sessions"],
      logger,
      redactor,
      models: [],
      ready: () => true,
    };
    const route = routes(ctx).find(item => item.method === "POST" && item.path === "/v1/messages")!;
    const body = Buffer.from(JSON.stringify({
      model: "deepseek-v4-flash",
      max_tokens: 8,
      stream: false,
      messages: [{ role: "user", content: "raw-body" }],
    }));
    const req = {
      headers: {},
      async *[Symbol.asyncIterator]() { yield body; },
    } as never;
    const response = { body: "", headersSent: false, writableEnded: false, destroyed: false };
    const res = {
      get headersSent() { return response.headersSent; },
      get writableEnded() { return response.writableEnded; },
      get destroyed() { return response.destroyed; },
      writeHead: () => { response.headersSent = true; },
      write: () => true,
      end: (chunk?: string) => { response.body += chunk ?? ""; response.writableEnded = true; },
    } as never;
    await route.handler(req, res, "req-unhandled");
    expect(entries.find(entry => entry.msg === "route_error_unhandled")).toMatchObject({
      request_ref: "req-unhandled",
      fields: { stage: "route", outcome: "failure", failure_class: "UNHANDLED_ERROR" },
    });
    expect(JSON.stringify(entries)).not.toMatch(/synthetic-token|C:\\\\private|raw-body/);
    expect(response.body).toContain("Internal server error");
  });

  it("separates completion_attempt from guard_attempt on retry then success", async () => {
    const entries: LogEntry[] = [];
    const client = observedClient(entries, [
      "I ran pwd. Output: C:/invented",
      '{"tool_call":{"name":"Bash","arguments":{"command":"pwd"}}}',
    ]);
    await expect(client.complete(request([instruction()]), state(), {}, undefined, entriesLogger(entries).withRequestRef("req-guard")))
      .resolves.toMatchObject({ toolCall: { name: "Bash" } });
    const starts = entries.filter(entry => entry.msg === "completion_attempt_start");
    expect(starts.map(entry => [entry.fields.completion_attempt, entry.fields.guard_attempt])).toEqual([[1, 0], [2, 1]]);
    expect(starts[1]?.fields.parent_state).toBe("repair_candidate");
    expect(entries.find(entry => entry.msg === "completion_guard_retry")?.fields).toMatchObject({
      completion_attempt: 2,
      guard_attempt: 1,
      outcome: "retry",
    });
  });

  it("records bounded guard exhaustion as a non-empty typed failure", async () => {
    const entries: LogEntry[] = [];
    const client = observedClient(entries, Array(3).fill("pwd\nOutput: C:/invented"));
    await expect(client.complete(request([instruction()]), state(), {}, undefined, entriesLogger(entries).withRequestRef("req-exhaust")))
      .rejects.toMatchObject({ code: "TOOL_CALL_REQUIRED" });
    const rejected = entries.find(entry => entry.msg === "completion_guard_rejected");
    expect(rejected?.fields).toMatchObject({
      completion_attempt: 3,
      guard_attempt: 2,
      failure_class: "TOOL_CALL_REQUIRED",
      outcome: "failure",
    });
  });

  it.each([
    ["timeout", new BridgeError("unsafe timeout path", { code: "UPSTREAM_TIMEOUT", status: 504, retryable: true, upstreamStage: "completion_body", causeCode: "deadline_exceeded" })],
    ["rate limit", new BridgeError("unsafe rate body", { code: "DEEPSEEK_RATE_LIMIT", status: 429, retryable: true, upstreamStage: "completion", causeCode: "rate_limit_reached" })],
    ["incomplete stream", new BridgeError("unsafe partial body", { code: "STREAM_INCOMPLETE", status: 502, retryable: true, upstreamStage: "completion_body", causeCode: "eof_before_terminal" })],
  ])("emits safe typed telemetry for %s", async (_name, error) => {
    const entries: LogEntry[] = [];
    const logger = entriesLogger(entries).withRequestRef(`req-${_name}`);
    const client = observedClient(entries, [error]);
    await expect(client.complete(request([instruction("Explain hello")], []), state(), {}, undefined, logger)).rejects.toBe(error);
    const failed = entries.find(entry => entry.msg === "completion_attempt_failed");
    expect(failed?.fields).toMatchObject({
      failure_class: error.code,
      cause_code: error.causeCode,
      retryable: error.retryable,
      outcome: "failure",
    });
    expect(JSON.stringify(entries)).not.toContain(error.message);
  });

  it("keeps concurrent request log streams isolated", async () => {
    const entries: LogEntry[] = [];
    const root = entriesLogger(entries);
    const run = async (requestRef: string, rawClient: string) => {
      const logger = root.withRequestRef(requestRef);
      const deepseek = {
        getAuthGeneration: () => 0,
        ensureSession: async (session: UpstreamSessionState, _generation: number, scoped: Logger) => {
          session.chatSessionId = `chat-${rawClient}`;
          scoped.info("concurrent_session", { stage: "session" });
          await new Promise(resolve => setTimeout(resolve, 1));
        },
        complete: async (_request: unknown, _state: unknown, _callbacks: unknown, _generation: number, scoped: Logger) => {
          scoped.info("concurrent_completion", { stage: "completion" });
          return { content: "ok" };
        },
      } as unknown as DeepSeekClient;
      const handler = new CompletionHandler({ deepseek, sessionStore: new SessionStore(), lineage: memoryLineage(), logger: root });
      await handler.run({
        protocol: "anthropic",
        request: request([instruction("hello")], []),
        headers: { "x-claude-code-session-id": rawClient },
        body: { user: `upstream-${rawClient}` },
        stream: streamStub(),
        logger,
      });
    };
    await Promise.all([run("req-A", "client-A-raw"), run("req-B", "client-B-raw")]);
    const refs = entries.filter(entry => entry.msg.startsWith("concurrent_")).map(entry => entry.request_ref);
    expect(refs.sort()).toEqual(["req-A", "req-A", "req-B", "req-B"]);
    expect(JSON.stringify(entries)).not.toMatch(/client-[AB]-raw/);
  });
});
