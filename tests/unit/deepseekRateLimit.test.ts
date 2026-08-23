import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanonicalRequest } from "../../src/api/canonical.js";
import { DeepSeekClient } from "../../src/deepseek/client.js";
import { isDeepSeekRateLimitHint, parseSseBlock } from "../../src/deepseek/sseParser.js";
import type { UpstreamSessionState } from "../../src/sessions/sessionStore.js";

const originalFetch = globalThis.fetch;

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

function client(loggerWarn = vi.fn()): DeepSeekClient {
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
    logger: { info: () => {}, warn: loggerWarn, error: () => {} } as never,
    redactor: { addSecret: () => {}, redactText: (text: string) => text } as never,
    timeoutMs: 10_000,
    maxRetries: 0,
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
    messages: [{
      role: "user",
      parts: [{ type: "text", text: withTools ? "Run pwd using Bash." : "Reply OK." }],
    }],
    tools: withTools ? [{
      name: "Bash",
      description: "Run a shell command",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    }] : [],
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const SUCCESS_UPDATE = [
  "data: {\"v\":{\"response\":{\"message_id\":2,\"fragments\":[{\"type\":\"RESPONSE\",\"content\":\"OK\"}],\"status\":\"FINISHED\"}}}",
  "",
  "",
].join("\n");

describe("DeepSeek SSE rate-limit hints", () => {
  it("recognizes the explicit rate_limit_reached hint", () => {
    const event = parseSseBlock([
      "event: hint",
      "data: {\"type\":\"error\",\"content\":\"Messages too frequent. Try again later.\",\"clear_response\":true,\"finish_reason\":\"rate_limit_reached\"}",
    ].join("\n"));

    expect(event?.type).toBe("hint");
    expect(event?.jsonParseFailed).toBe(false);
    expect(event && isDeepSeekRateLimitHint(event)).toBe(true);
  });

  it("does not classify ordinary hint events as rate limits", () => {
    const event = parseSseBlock([
      "event: hint",
      "data: {\"type\":\"info\",\"content\":\"Keep going\",\"finish_reason\":\"none\"}",
    ].join("\n"));

    expect(event?.type).toBe("hint");
    expect(event?.jsonParseFailed).toBe(false);
    expect(event && isDeepSeekRateLimitHint(event)).toBe(false);
  });

  it("throws one retryable upstream rate-limit error without completion-guard retries", async () => {
    let challengeCalls = 0;
    let completionCalls = 0;
    const loggerWarn = vi.fn();
    globalThis.fetch = vi.fn(async input => {
      const url = String(input);
      if (url.endsWith("/api/v0/chat/create_pow_challenge")) {
        challengeCalls++;
        return jsonResponse(CHALLENGE_RESPONSE);
      }
      if (url.endsWith("/api/v0/chat/completion")) {
        completionCalls++;
        return sseResponse([
          "event: hint",
          "data: {\"type\":\"error\",\"content\":\"Messages too frequent. Try again later.\",\"clear_response\":true,\"finish_reason\":\"rate_limit_reached\"}",
        ].join("\n"));
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof globalThis.fetch;

    await expect(client(loggerWarn).complete(request(true), state())).rejects.toMatchObject({
      code: "DEEPSEEK_RATE_LIMIT",
      status: 429,
      retryable: true,
      upstreamStage: "completion",
      causeCode: "rate_limit_reached",
      message: "DeepSeek upstream rate limit reached. Try again later.",
    });
    expect(challengeCalls).toBe(1);
    expect(completionCalls).toBe(1);
    expect(loggerWarn).not.toHaveBeenCalledWith("completion_guard_rejected", expect.anything());
  });

  it("keeps normal successful DeepSeek SSE completions working", async () => {
    globalThis.fetch = vi.fn(async input => {
      const url = String(input);
      if (url.endsWith("/api/v0/chat/create_pow_challenge")) return jsonResponse(CHALLENGE_RESPONSE);
      if (url.endsWith("/api/v0/chat/completion")) return sseResponse(SUCCESS_UPDATE);
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof globalThis.fetch;

    await expect(client().complete(request(), state())).resolves.toMatchObject({ content: "OK" });
  });

  it("ignores non-rate-limit hints and continues parsing successful updates", async () => {
    globalThis.fetch = vi.fn(async input => {
      const url = String(input);
      if (url.endsWith("/api/v0/chat/create_pow_challenge")) return jsonResponse(CHALLENGE_RESPONSE);
      if (url.endsWith("/api/v0/chat/completion")) {
        return sseResponse([
          "event: hint",
          "data: {\"type\":\"info\",\"content\":\"Informational hint\"}",
          "",
          SUCCESS_UPDATE,
        ].join("\n"));
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof globalThis.fetch;

    await expect(client().complete(request(), state())).resolves.toMatchObject({ content: "OK" });
  });
});
