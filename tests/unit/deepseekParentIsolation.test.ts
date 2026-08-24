import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanonicalRequest } from "../../src/api/canonical.js";
import { CompletionHandler } from "../../src/api/handler.js";
import { DeepSeekClient } from "../../src/deepseek/client.js";
import { SessionStore, type UpstreamSessionState } from "../../src/sessions/sessionStore.js";

const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const CHALLENGE_RESPONSE = {
  code: 0,
  data: {
    biz_code: 0,
    biz_data: {
      challenge: {
        target_path: "/api/v0/chat/completion",
        signature: "test-signature",
        salt: "test-salt",
        challenge: "test-challenge",
        algorithm: "DeepSeekHashV1",
        difficulty: 1,
        expire_at: Date.now() + 60_000,
      },
    },
  },
};

interface CapturedPayload {
  chat_session_id: string | null;
  parent_message_id: number | null;
  prompt: string;
}

function makeClient(timeoutMs = 100): DeepSeekClient {
  return new DeepSeekClient({
    baseUrl: "https://chat.deepseek.com",
    auth: { token: "test-token", cookie: "test-cookie" },
    sessionManager: {} as never,
    solver: {
      solve: async () => ({
        answer: 1,
        signature: "test-signature",
        algorithm: "DeepSeekHashV1",
        salt: "test-salt",
        challenge: "test-challenge",
      }),
    } as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    redactor: { addSecret: () => {}, redactText: (text: string) => text } as never,
    timeoutMs,
    maxRetries: 0,
  });
}

function state(parentMessageId = 77): UpstreamSessionState {
  return { chatSessionId: "d2-session", parentMessageId, history: [], updatedAt: 0 };
}

const bashTool = {
  name: "Bash",
  description: "Run a shell command",
  inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};

const editTool = {
  name: "Edit",
  description: "Edit a file",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
    },
    required: ["file_path", "old_string", "new_string"],
  },
};

function request(kind: "text" | "bash" | "edit" = "text"): CanonicalRequest {
  return {
    model: "deepseek-v4-flash",
    stream: false,
    system: "",
    messages: [{
      role: "user",
      parts: [{
        type: "text",
        text: kind === "bash"
          ? "Run pwd using Bash and answer only after the tool result."
          : kind === "edit"
            ? "Edit server.js using the Edit tool."
            : "Reply OK.",
      }],
    }],
    tools: kind === "bash" ? [bashTool] : kind === "edit" ? [editTool] : [],
  };
}

function challengeResponse(): Response {
  return new Response(JSON.stringify(CHALLENGE_RESPONSE), { status: 200 });
}

function sse(data: unknown, event?: string): string {
  return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

function snapshot(content: string, messageId?: number, status?: "FINISHED" | "INCOMPLETE"): string {
  return sse({
    v: {
      response: {
        ...(messageId === undefined ? {} : { message_id: messageId }),
        fragments: [{ type: "RESPONSE", content }],
        ...(status ? { status } : {}),
      },
    },
  });
}

function streamResponse(
  chunks: string[],
  options: { close?: boolean; errorAfterFirst?: boolean } = {},
): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) return;
      controller.enqueue(encoder.encode(chunks[index++]!));
      if (options.errorAfterFirst && index === 1) controller.error(new Error("socket reset"));
      else if (options.close !== false && index === chunks.length) controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function finished(content: string, messageId?: number): () => Response {
  return () => streamResponse([snapshot(content, messageId, "FINISHED")], { close: false });
}

function installSequence(factories: Array<() => Response | Promise<Response>>): CapturedPayload[] {
  const payloads: CapturedPayload[] = [];
  let completionIndex = 0;
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v0/chat/create_pow_challenge")) return challengeResponse();
    if (!url.endsWith("/api/v0/chat/completion")) throw new Error(`Unexpected URL: ${url}`);
    payloads.push(JSON.parse(String(init?.body)) as CapturedPayload);
    const factory = factories[completionIndex++];
    if (!factory) throw new Error(`Missing completion response ${completionIndex}`);
    return factory();
  }) as typeof globalThis.fetch;
  return payloads;
}

const validBashCall = JSON.stringify({ tool_call: { name: "Bash", arguments: { command: "pwd" } } });
const malformedBashCall = String.raw`{"tool_call":{"name":"Bash","arguments":{"command":"pwd\a"}}}`;
const secondMalformedBashCall = String.raw`{"tool_call":{"name":"Bash","arguments":{"command":"pwd\q"}}}`;

function expectParents(payloads: CapturedPayload[], expected: Array<number | null>): void {
  expect(payloads.map(payload => payload.parent_message_id)).toEqual(expected);
}

function handlerStream() {
  return {
    start: vi.fn(),
    push: vi.fn(),
    finish: vi.fn(),
    fail: vi.fn(),
  };
}

function makeHandler(client: DeepSeekClient, sessionStore: SessionStore): CompletionHandler {
  return new CompletionHandler({
    deepseek: client,
    sessionStore,
    lineage: {
      getUpstreamKey: () => undefined,
      record: vi.fn(async () => {}),
      removeByUpstreamKey: vi.fn(async () => {}),
    } as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
  });
}

describe("D2 accepted DeepSeek parent isolation", () => {
  it("PB29: commits a normal accepted candidate 77 -> 1001", async () => {
    const payloads = installSequence([finished("OK", 1001)]);
    const currentState = state();

    await expect(makeClient().complete(request(), currentState)).resolves.toMatchObject({
      content: "OK",
      parentMessageId: 1001,
    });
    expectParents(payloads, [77]);
    expect(currentState.parentMessageId).toBe(1001);
  });

  it("PB30: chains a rejected candidate locally and commits only the accepted retry", async () => {
    const payloads = installSequence([
      finished(malformedBashCall, 1001),
      finished(validBashCall, 1002),
    ]);
    const currentState = state();

    await expect(makeClient().complete(request("bash"), currentState)).resolves.toMatchObject({
      parentMessageId: 1002,
      toolCall: { name: "Bash", args: { command: "pwd" } },
    });
    expectParents(payloads, [77, 1001]);
    expect(currentState.parentMessageId).toBe(1002);
  });

  it("PB30: locally chains two rejects before committing the accepted candidate", async () => {
    const payloads = installSequence([
      finished(malformedBashCall, 1001),
      finished(secondMalformedBashCall, 1002),
      finished(validBashCall, 1003),
    ]);
    const currentState = state();

    await expect(makeClient().complete(request("bash"), currentState)).resolves.toMatchObject({ parentMessageId: 1003 });
    expectParents(payloads, [77, 1001, 1002]);
    expect(currentState.parentMessageId).toBe(1003);
  });

  it("PB30: guard exhaustion leaves the accepted parent unchanged", async () => {
    const payloads = installSequence([
      finished(malformedBashCall, 1001),
      finished(secondMalformedBashCall, 1002),
      finished(malformedBashCall, 1003),
    ]);
    const currentState = state();

    await expect(makeClient().complete(request("bash"), currentState)).rejects.toMatchObject({ code: "TOOL_CALL_REQUIRED" });
    expectParents(payloads, [77, 1001, 1002]);
    expect(currentState.parentMessageId).toBe(77);
  });

  it("PB30: candidate followed by INCOMPLETE leaves the accepted parent unchanged", async () => {
    installSequence([() => streamResponse([snapshot("PARTIAL", 1001, "INCOMPLETE")], { close: false })]);
    const currentState = state();

    await expect(makeClient().complete(request(), currentState)).rejects.toMatchObject({ code: "STREAM_INCOMPLETE" });
    expect(currentState.parentMessageId).toBe(77);
  });

  it("PB30: candidate followed by a body timeout leaves the accepted parent unchanged", async () => {
    installSequence([() => streamResponse([snapshot("PARTIAL", 1001)], { close: false })]);
    const currentState = state();

    await expect(makeClient(25).complete(request(), currentState)).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT" });
    expect(currentState.parentMessageId).toBe(77);
  });

  it("PB30: candidate followed by a body read error leaves the accepted parent unchanged", async () => {
    installSequence([() => streamResponse([snapshot("PARTIAL", 1001)], { errorAfterFirst: true })]);
    const currentState = state();

    await expect(makeClient().complete(request(), currentState)).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(currentState.parentMessageId).toBe(77);
  });

  it("PB30: candidate followed by a rate-limit hint leaves the accepted parent unchanged", async () => {
    installSequence([() => streamResponse([
      snapshot("PARTIAL", 1001) + sse({ type: "error", finish_reason: "rate_limit_reached" }, "hint"),
    ], { close: false })]);
    const currentState = state();

    await expect(makeClient().complete(request(), currentState)).rejects.toMatchObject({ code: "DEEPSEEK_RATE_LIMIT" });
    expect(currentState.parentMessageId).toBe(77);
  });

  it("PB30: candidate followed by malformed SSE leaves the accepted parent unchanged", async () => {
    installSequence([() => streamResponse([
      snapshot("PARTIAL", 1001) + "event: update\ndata: {\"v\":\n\n",
    ], { close: false })]);
    const currentState = state();

    await expect(makeClient().complete(request(), currentState)).rejects.toMatchObject({ code: "STREAM_PARSE_FAILED" });
    expect(currentState.parentMessageId).toBe(77);
  });

  it("PB29: an accepted tool call commits its candidate after the callback succeeds", async () => {
    installSequence([finished(validBashCall, 1001)]);
    const currentState = state();
    const onToolCall = vi.fn();

    await expect(makeClient().complete(request("bash"), currentState, { onToolCall })).resolves.toMatchObject({
      parentMessageId: 1001,
      toolCall: { name: "Bash" },
    });
    expect(onToolCall).toHaveBeenCalledOnce();
    expect(currentState.parentMessageId).toBe(1001);
  });

  it("PB30: callback failure does not publish the candidate parent", async () => {
    installSequence([finished(validBashCall, 1001)]);
    const currentState = state();

    await expect(makeClient().complete(request("bash"), currentState, {
      onToolCall: () => { throw new Error("callback failed"); },
    })).rejects.toThrow("callback failed");
    expect(currentState.parentMessageId).toBe(77);
  });

  it("PB30: final auth-generation rejection does not publish the candidate parent", async () => {
    installSequence([finished(validBashCall, 1001)]);
    const currentState = state();
    const client = makeClient();

    await expect(client.complete(request("bash"), currentState, {
      onToolCall: () => client.clearAuth(),
    })).rejects.toMatchObject({ code: "SESSION_CONFLICT" });
    expect(currentState.parentMessageId).toBe(77);
  });

  it("PB30: malformed Edit repair commits only the accepted candidate", async () => {
    const malformedEdit = String.raw`{"tool_call":{"name":"Edit","arguments":{"file_path":"server.js","old_string":"// Middleware\app.use(cors())","new_string":"fixed"}}}`;
    const validEdit = JSON.stringify({
      tool_call: {
        name: "Edit",
        arguments: { file_path: "server.js", old_string: "// Middleware\napp.use(cors())", new_string: "fixed" },
      },
    });
    const payloads = installSequence([finished(malformedEdit, 1001), finished(validEdit, 1002)]);
    const currentState = state();

    await expect(makeClient().complete(request("edit"), currentState)).resolves.toMatchObject({
      parentMessageId: 1002,
      toolCall: { name: "Edit" },
    });
    expectParents(payloads, [77, 1001]);
    expect(currentState.parentMessageId).toBe(1002);
  });

  it("PB30: the next request after a failed completion still uses parent 77", async () => {
    const payloads = installSequence([
      finished(malformedBashCall, 1001),
      finished(secondMalformedBashCall, 1002),
      finished(malformedBashCall, 1003),
      finished("RECOVERED", 2001),
    ]);
    const currentState = state();

    await expect(makeClient().complete(request("bash"), currentState)).rejects.toMatchObject({ code: "TOOL_CALL_REQUIRED" });
    await expect(makeClient().complete(request(), currentState)).resolves.toMatchObject({ content: "RECOVERED" });
    expectParents(payloads, [77, 1001, 1002, 77]);
  });

  it("PB29: the next request after success uses the accepted candidate", async () => {
    const payloads = installSequence([finished("FIRST", 1001), finished("SECOND", 2001)]);
    const currentState = state();
    const client = makeClient();

    await client.complete(request(), currentState);
    await client.complete(request(), currentState);
    expectParents(payloads, [77, 1001]);
    expect(currentState.parentMessageId).toBe(2001);
  });

  it("PB29: handler history records only the accepted message ID", async () => {
    installSequence([finished("ACCEPTED", 1001)]);
    const sessionStore = new SessionStore();
    const currentState = sessionStore.getOrCreate("D2-HISTORY");
    currentState.chatSessionId = "d2-session";
    currentState.parentMessageId = 77;
    const handler = makeHandler(makeClient(), sessionStore);

    await handler.run({
      protocol: "anthropic",
      request: request(),
      headers: {},
      body: { metadata: { user_id: "D2-HISTORY" } },
      stream: handlerStream() as never,
    });

    expect(currentState.history).toEqual([{ role: "assistant", content: "ACCEPTED", messageId: 1001 }]);
  });

  it("PB30: a failed handler completion creates no history", async () => {
    installSequence([
      finished(malformedBashCall, 1001),
      finished(secondMalformedBashCall, 1002),
      finished(malformedBashCall, 1003),
    ]);
    const sessionStore = new SessionStore();
    const currentState = sessionStore.getOrCreate("D2-FAILED-HISTORY");
    currentState.chatSessionId = "d2-session";
    currentState.parentMessageId = 77;
    const handler = makeHandler(makeClient(), sessionStore);

    await expect(handler.run({
      protocol: "anthropic",
      request: request("bash"),
      headers: {},
      body: { metadata: { user_id: "D2-FAILED-HISTORY" } },
      stream: handlerStream() as never,
    })).rejects.toMatchObject({ code: "TOOL_CALL_REQUIRED" });

    expect(currentState.parentMessageId).toBe(77);
    expect(currentState.history).toEqual([]);
  });

  it("PB29: legacy message_id=12 wins over new_parent_message_id=42", async () => {
    const body = sse({
      data: { type: "response_message", message_id: 11, message: { content: "OLD" } },
    }) + sse({
      data: {
        type: "response_message_done",
        message_id: 12,
        message: { content: "", new_parent_message_id: 42 },
      },
    });
    installSequence([() => streamResponse([body], { close: false })]);
    const currentState = state();

    await expect(makeClient().complete(request(), currentState)).resolves.toMatchObject({ parentMessageId: 12 });
    expect(currentState.parentMessageId).toBe(12);
  });

  it("PB29: a successful no-ID result leaves the accepted parent unchanged", async () => {
    const payloads = installSequence([finished("NO-ID")]);
    const currentState = state();

    await expect(makeClient().complete(request(), currentState)).resolves.toMatchObject({
      content: "NO-ID",
      parentMessageId: 77,
    });
    expectParents(payloads, [77]);
    expect(currentState.parentMessageId).toBe(77);
  });
});
