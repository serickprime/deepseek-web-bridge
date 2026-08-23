import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanonicalRequest } from "../../src/api/canonical.js";
import { DeepSeekClient } from "../../src/deepseek/client.js";
import type { UpstreamSessionState } from "../../src/sessions/sessionStore.js";

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

function makeClient(options: { timeoutMs?: number; maxRetries?: number; warn?: ReturnType<typeof vi.fn> } = {}): DeepSeekClient {
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
    logger: { info: () => {}, warn: options.warn ?? vi.fn(), error: () => {} } as never,
    redactor: { addSecret: () => {}, redactText: (text: string) => text } as never,
    timeoutMs: options.timeoutMs ?? 100,
    maxRetries: options.maxRetries ?? 0,
  });
}

function state(): UpstreamSessionState {
  return { chatSessionId: "test-session", parentMessageId: null, history: [], updatedAt: 0 };
}

function request(withTools = false): CanonicalRequest {
  return {
    model: "deepseek-v4-flash",
    stream: false,
    system: "",
    messages: [{ role: "user", parts: [{ type: "text", text: withTools ? "Run pwd using Bash." : "Reply OK." }] }],
    tools: withTools ? [{
      name: "Bash",
      description: "Run a shell command",
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    }] : [],
  };
}

function challengeResponse(): Response {
  return new Response(JSON.stringify(CHALLENGE_RESPONSE), { status: 200 });
}

function sse(data: unknown, event?: string): string {
  return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

function newSnapshot(content: string, status?: "FINISHED" | "INCOMPLETE", messageId = 2): string {
  return sse({
    v: {
      response: {
        message_id: messageId,
        fragments: [{ type: "RESPONSE", content }],
        ...(status ? { status } : {}),
      },
    },
  });
}

function statusEvent(status: "FINISHED" | "INCOMPLETE"): string {
  return sse({ v: { p: "response/status", o: "SET", v: status } });
}

function streamResponse(
  chunks: string[],
  options: { close?: boolean; cancel?: ReturnType<typeof vi.fn>; errorAfterFirst?: boolean } = {},
): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]!));
        if (options.errorAfterFirst && index === 1) controller.error(new Error("socket reset"));
        else if (options.close !== false && index === chunks.length) controller.close();
      }
    },
    cancel() {
      options.cancel?.();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function stalledResponse(status = 200, cancel = vi.fn()): { response: Response; cancel: ReturnType<typeof vi.fn> } {
  const response = new Response(new ReadableStream<Uint8Array>({
    pull() {},
    cancel() { cancel(); },
  }), { status });
  return { response, cancel };
}

function installFetch(completion: () => Response | Promise<Response>): { challengeCalls: () => number; completionCalls: () => number } {
  let challengeCalls = 0;
  let completionCalls = 0;
  globalThis.fetch = vi.fn(async input => {
    const url = String(input);
    if (url.endsWith("/api/v0/chat/create_pow_challenge")) {
      challengeCalls++;
      return challengeResponse();
    }
    if (url.endsWith("/api/v0/chat/completion")) {
      completionCalls++;
      return completion();
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof globalThis.fetch;
  return { challengeCalls: () => challengeCalls, completionCalls: () => completionCalls };
}

describe("DeepSeek upstream stream lifecycle", () => {
  it("T1: new FINISHED succeeds without waiting for EOF", async () => {
    const cancel = vi.fn();
    installFetch(() => streamResponse([newSnapshot("NEW", "FINISHED")], { close: false, cancel }));

    await expect(makeClient().complete(request(), state())).resolves.toMatchObject({ content: "NEW" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("T2: old response_message_done succeeds without waiting for EOF", async () => {
    const cancel = vi.fn();
    installFetch(() => streamResponse([sse({
      data: { type: "response_message_done", message_id: 3, message: { content: "OLD", new_parent_message_id: 7 } },
    })], { close: false, cancel }));

    await expect(makeClient().complete(request(), state())).resolves.toMatchObject({ content: "OLD", parentMessageId: 3 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("T3: zero-byte HTTP 200 is STREAM_INCOMPLETE", async () => {
    installFetch(() => new Response("", { status: 200 }));
    await expect(makeClient().complete(request(), state())).rejects.toMatchObject({
      code: "STREAM_INCOMPLETE", status: 502, retryable: true, causeCode: "empty_stream",
    });
  });

  it("T4: partial content followed by EOF is STREAM_INCOMPLETE", async () => {
    installFetch(() => streamResponse([newSnapshot("PARTIAL")]));
    await expect(makeClient().complete(request(), state())).rejects.toMatchObject({
      code: "STREAM_INCOMPLETE", causeCode: "eof_before_terminal",
    });
  });

  it("T5: explicit INCOMPLETE is a typed failure", async () => {
    installFetch(() => streamResponse([newSnapshot("PARTIAL", "INCOMPLETE")], { close: false }));
    await expect(makeClient().complete(request(), state())).rejects.toMatchObject({
      code: "STREAM_INCOMPLETE", status: 502, retryable: true, upstreamStage: "completion_body", causeCode: "upstream_incomplete",
    });
  });

  it("T6: a stalled body is bounded and aborts and cancels", async () => {
    const stalled = stalledResponse();
    let completionSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (input, init) => {
      if (String(input).endsWith("create_pow_challenge")) return challengeResponse();
      completionSignal = init?.signal as AbortSignal;
      return stalled.response;
    }) as typeof globalThis.fetch;

    await expect(makeClient({ timeoutMs: 25 }).complete(request(), state())).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT", status: 504, retryable: true, upstreamStage: "completion_body", causeCode: "deadline_exceeded",
    });
    expect(completionSignal?.aborted).toBe(true);
    expect(stalled.cancel).toHaveBeenCalledOnce();
  });

  it("T7: FINISHED terminates a never-ending socket", async () => {
    const cancel = vi.fn();
    installFetch(() => streamResponse([newSnapshot("DONE", "FINISHED")], { close: false, cancel }));
    const started = Date.now();
    await expect(makeClient({ timeoutMs: 500 }).complete(request(), state())).resolves.toMatchObject({ content: "DONE" });
    expect(Date.now() - started).toBeLessThan(250);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("T8: a mid-body read error is normalized to UPSTREAM_ERROR", async () => {
    installFetch(() => streamResponse([newSnapshot("PARTIAL")], { errorAfterFirst: true }));
    await expect(makeClient().complete(request(), state())).rejects.toMatchObject({
      code: "UPSTREAM_ERROR", status: 502, upstreamStage: "completion_body", causeCode: "body_read_failed",
    });
  });

  it("T9: malformed JSON claiming the supported update protocol fails explicitly", async () => {
    installFetch(() => streamResponse(["event: update\ndata: {\"v\":\n\n"], { close: false }));
    await expect(makeClient().complete(request(), state())).rejects.toMatchObject({
      code: "STREAM_PARSE_FAILED", status: 502, retryable: false, causeCode: "malformed_update",
    });
  });

  it("T9b: harmless raw, comment, ordinary hint, and unknown events remain ignorable", async () => {
    const body = [
      ": keep-alive\n\n",
      "data: keep-alive\n\n",
      "event: hint\ndata: ordinary upstream notice\n\n",
      "event: future-event\ndata: {not-json\n\n",
      newSnapshot("OK", "FINISHED"),
    ].join("");
    installFetch(() => streamResponse([body]));
    await expect(makeClient().complete(request(), state())).resolves.toMatchObject({ content: "OK" });
  });

  it("T10: HTTP 429 is typed and completion is attempted once", async () => {
    const calls = installFetch(() => new Response(null, { status: 429 }));
    await expect(makeClient({ maxRetries: 3 }).complete(request(), state())).rejects.toMatchObject({
      code: "DEEPSEEK_RATE_LIMIT", status: 429, retryable: true, upstreamStage: "completion_headers", causeCode: "http_429",
    });
    expect(calls.completionCalls()).toBe(1);
  });

  it.each([500, 502, 503])("T11: HTTP %i is typed and attempted once", async status => {
    const calls = installFetch(() => new Response(null, { status }));
    await expect(makeClient({ maxRetries: 3 }).complete(request(), state())).rejects.toMatchObject({
      code: "UPSTREAM_ERROR", status: 502, retryable: true, upstreamStage: "completion_headers", causeCode: `http_${status}`,
    });
    expect(calls.completionCalls()).toBe(1);
  });

  it("T11b: a non-rate-limit HTTP 4xx is not marked retryable", async () => {
    const calls = installFetch(() => new Response(null, { status: 400 }));
    await expect(makeClient({ maxRetries: 3 }).complete(request(), state())).rejects.toMatchObject({
      code: "UPSTREAM_ERROR", status: 502, retryable: false, upstreamStage: "completion_headers", causeCode: "http_400",
    });
    expect(calls.completionCalls()).toBe(1);
  });

  it("T12: a completion network failure before headers is attempted once", async () => {
    const calls = installFetch(async () => { throw new Error("network down"); });
    await expect(makeClient({ maxRetries: 3 }).complete(request(), state())).rejects.toMatchObject({
      code: "UPSTREAM_ERROR", status: 502, upstreamStage: "completion_headers", causeCode: "transport_error",
    });
    expect(calls.completionCalls()).toBe(1);
  });

  it("T13: a pre-header completion stall times out after one attempt", async () => {
    let completionCalls = 0;
    globalThis.fetch = vi.fn((input, init) => {
      if (String(input).endsWith("create_pow_challenge")) return Promise.resolve(challengeResponse());
      completionCalls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as typeof globalThis.fetch;

    await expect(makeClient({ timeoutMs: 25, maxRetries: 3 }).complete(request(), state())).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT", status: 504, upstreamStage: "completion_headers", causeCode: "deadline_exceeded",
    });
    expect(completionCalls).toBe(1);
  });

  it("T14: a stalled HTTP error body cannot delay the status failure", async () => {
    const stalled = stalledResponse(502);
    const calls = installFetch(() => stalled.response);
    const started = Date.now();
    await expect(makeClient({ timeoutMs: 500 }).complete(request(), state())).rejects.toMatchObject({
      code: "UPSTREAM_ERROR", causeCode: "http_502",
    });
    expect(Date.now() - started).toBeLessThan(250);
    expect(calls.completionCalls()).toBe(1);
    expect(stalled.cancel).toHaveBeenCalledOnce();
  });

  it("T15: HTTP 200 rate-limit hint retains its closed regression contract", async () => {
    const calls = installFetch(() => streamResponse([
      sse({ type: "error", finish_reason: "rate_limit_reached" }, "hint"),
    ], { close: false }));
    await expect(makeClient({ maxRetries: 3 }).complete(request(true), state())).rejects.toMatchObject({
      code: "DEEPSEEK_RATE_LIMIT", status: 429, retryable: true, upstreamStage: "completion", causeCode: "rate_limit_reached",
    });
    expect(calls.completionCalls()).toBe(1);
  });

  it("T16: rejected terminal cancellation does not replace success or abort its controller", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const cancel = vi.fn(async () => { throw new Error("cancel failed"); });
    const releaseLock = vi.fn();
    const read = vi.fn(async () => ({ done: false as const, value: encoder.encode(newSnapshot("OK", "FINISHED")) }));
    const response = {
      status: 200,
      ok: true,
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    } as unknown as Response;
    let signal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (input, init) => {
      if (String(input).endsWith("create_pow_challenge")) return challengeResponse();
      signal = init?.signal as AbortSignal;
      return response;
    }) as typeof globalThis.fetch;

    await expect(makeClient().complete(request(), state())).resolves.toMatchObject({ content: "OK" });
    expect(read).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(false);
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("T16b: a hanging reader cancellation cannot replace terminal success with a timeout", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const releaseLock = vi.fn();
    const read = vi.fn(async () => ({ done: false as const, value: encoder.encode(newSnapshot("OK", "FINISHED")) }));
    const response = {
      status: 200,
      ok: true,
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    } as unknown as Response;
    let signal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (input, init) => {
      if (String(input).endsWith("create_pow_challenge")) return challengeResponse();
      signal = init?.signal as AbortSignal;
      return response;
    }) as typeof globalThis.fetch;

    await expect(makeClient({ timeoutMs: 25 }).complete(request(), state())).resolves.toMatchObject({ content: "OK" });
    expect(read).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(false);
  });

  it("T17: transport failure exits before the completion guard", async () => {
    const warn = vi.fn();
    const calls = installFetch(async () => { throw new Error("offline"); });
    await expect(makeClient({ maxRetries: 3, warn }).complete(request(true), state())).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(calls.completionCalls()).toBe(1);
    expect(warn).not.toHaveBeenCalledWith("completion_guard_rejected", expect.anything());
  });

  it("T18: events after the first successful terminal are ignored", async () => {
    const body = newSnapshot("DONE") + statusEvent("FINISHED") + newSnapshot("LATE", "FINISHED", 99);
    installFetch(() => streamResponse([body], { close: false }));
    const currentState = state();
    await expect(makeClient().complete(request(), currentState)).resolves.toMatchObject({ content: "DONE" });
    expect(currentState.parentMessageId).toBe(2);
  });

  it("T19: an undelimited trailing FINISHED event is processed on flush", async () => {
    const trailing = newSnapshot("TAIL").concat("data: {\"v\":{\"p\":\"response/status\",\"o\":\"SET\",\"v\":\"FINISHED\"}}");
    installFetch(() => streamResponse([trailing]));
    await expect(makeClient().complete(request(), state())).resolves.toMatchObject({ content: "TAIL" });
  });

  it("T20: challenge JSON body stall is bounded and cancelled", async () => {
    const stalled = stalledResponse();
    let challengeCalls = 0;
    let completionCalls = 0;
    globalThis.fetch = vi.fn(async input => {
      if (String(input).endsWith("create_pow_challenge")) {
        challengeCalls++;
        return stalled.response;
      }
      completionCalls++;
      return streamResponse([newSnapshot("SHOULD-NOT-RUN", "FINISHED")]);
    }) as typeof globalThis.fetch;

    await expect(makeClient({ timeoutMs: 25 }).complete(request(), state())).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT", status: 504, upstreamStage: "challenge_body", causeCode: "deadline_exceeded",
    });
    expect(challengeCalls).toBe(1);
    expect(completionCalls).toBe(0);
    expect(stalled.cancel).toHaveBeenCalledOnce();
  });

  it("T20b: safe challenge retrieval retains bounded retry", async () => {
    let challengeCalls = 0;
    let completionCalls = 0;
    globalThis.fetch = vi.fn(async input => {
      if (String(input).endsWith("create_pow_challenge")) {
        challengeCalls++;
        if (challengeCalls === 1) throw new Error("temporary challenge network error");
        return challengeResponse();
      }
      completionCalls++;
      return streamResponse([newSnapshot("OK", "FINISHED")]);
    }) as typeof globalThis.fetch;

    await expect(makeClient({ maxRetries: 1 }).complete(request(), state())).resolves.toMatchObject({ content: "OK" });
    expect(challengeCalls).toBe(2);
    expect(completionCalls).toBe(1);
  });

  it("T21: old-format content, parent, and usage extraction remains compatible", async () => {
    const body = sse({
      data: { type: "response_message", message_id: 11, message: { content: "OLD-CONTENT" } },
    }) + sse({
      data: {
        type: "response_message_done",
        message_id: 12,
        message: { content: "", new_parent_message_id: 42 },
        usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 2, completion_tokens: 5, total_tokens: 17 },
      },
    });
    installFetch(() => streamResponse([body], { close: false }));

    await expect(makeClient().complete(request(), state())).resolves.toMatchObject({
      content: "OLD-CONTENT",
      parentMessageId: 12,
      usage: { promptTokens: 12, completionTokens: 5, totalTokens: 17 },
    });
  });
});
