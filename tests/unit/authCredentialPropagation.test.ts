import { describe, expect, it, vi } from "vitest";
import { collectAuthSecrets } from "../../src/utils/redaction.js";

type FetchFn = typeof globalThis.fetch;

function mockFetch(fn: (...args: Parameters<FetchFn>) => Promise<Response>): { restore: () => void } {
  const prev = globalThis.fetch;
  const wrapped: FetchFn = ((...args: unknown[]) => fn(...(args as Parameters<FetchFn>))) as FetchFn;
  globalThis.fetch = wrapped;
  return { restore: () => { globalThis.fetch = prev; } };
}

describe("collectAuthSecrets", () => {
  it("collects camelCase hifLeim and hifDliq", () => {
    const secrets = collectAuthSecrets({ token: "t12345", cookie: "c67890", hifLeim: "leim_value_123", hifDliq: "dliq_value_123" });
    expect(secrets).toContain("t12345");
    expect(secrets).toContain("c67890");
    expect(secrets).toContain("leim_value_123");
    expect(secrets).toContain("dliq_value_123");
  });

  it("collects legacy snake_case hif keys", () => {
    const secrets = collectAuthSecrets({ token: "t12345", cookie: "c67890", hif_leim: "leim_legacy_123", hif_dliq: "dliq_legacy_123" });
    expect(secrets).toContain("leim_legacy_123");
    expect(secrets).toContain("dliq_legacy_123");
  });

  it("collects both camelCase and snake_case when both present", () => {
    const secrets = collectAuthSecrets({
      token: "t12345", cookie: "c67890",
      hif_leim: "leim_legacy_123", hif_dliq: "dliq_legacy_123",
      hifLeim: "leim_camel_123", hifDliq: "dliq_camel_123",
    });
    expect(secrets).toContain("leim_legacy_123");
    expect(secrets).toContain("dliq_legacy_123");
    expect(secrets).toContain("leim_camel_123");
    expect(secrets).toContain("dliq_camel_123");
  });

  it("does not collect short values (< 6 chars)", () => {
    const secrets = collectAuthSecrets({ token: "t12345", hifLeim: "short" });
    expect(secrets).not.toContain("short");
  });
});

describe("Auth credential propagation through DeepSeekClient", () => {
  it("camelCase hifLeim is passed to fetch headers", async () => {
    let capturedHeaders: Record<string, string> = {};
    const mock = mockFetch(async (_url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ data: { biz_data: { chat_session: { id: "sess_1" } } } }), { status: 200 });
    });

    try {
      const { DeepSeekClient } = await import("../../src/deepseek/client.js");
      const client = new DeepSeekClient({
        baseUrl: "https://example.com",
        auth: { token: "tok_123456", cookie: "c_123456", hifLeim: "camel_leim_value", hifDliq: "camel_dliq_value" },
        sessionManager: {} as never,
        solver: { solve: async () => ({ answer: 1, signature: "s", algorithm: "a", salt: "", challenge: "" }) } as never,
        logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
        redactor: { addSecret: () => {}, redactText: (t: string) => t } as never,
        timeoutMs: 10_000,
        maxRetries: 0,
      });
      const state = { chatSessionId: null, parentMessageId: null, history: [], updatedAt: 0 };
      await client.ensureSession(state);
      expect(capturedHeaders["x-hif-leim"]).toBe("camel_leim_value");
      expect(capturedHeaders["x-hif-dliq"]).toBe("camel_dliq_value");
    } finally {
      mock.restore();
    }
  });

  it("legacy hif_leim is also passed to fetch headers", async () => {
    let capturedHeaders: Record<string, string> = {};
    const mock = mockFetch(async (_url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ data: { biz_data: { chat_session: { id: "sess_1" } } } }), { status: 200 });
    });

    try {
      const { DeepSeekClient } = await import("../../src/deepseek/client.js");
      const client = new DeepSeekClient({
        baseUrl: "https://example.com",
        auth: { token: "tok_123456", cookie: "c_123456", hifLeim: "legacy_leim_value", hifDliq: "legacy_dliq_value" },
        sessionManager: {} as never,
        solver: { solve: async () => ({ answer: 1, signature: "s", algorithm: "a", salt: "", challenge: "" }) } as never,
        logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
        redactor: { addSecret: () => {}, redactText: (t: string) => t } as never,
        timeoutMs: 10_000,
        maxRetries: 0,
      });
      const state = { chatSessionId: null, parentMessageId: null, history: [], updatedAt: 0 };
      await client.ensureSession(state);
      expect(capturedHeaders["x-hif-leim"]).toBe("legacy_leim_value");
      expect(capturedHeaders["x-hif-dliq"]).toBe("legacy_dliq_value");
    } finally {
      mock.restore();
    }
  });

  it("clears runtime auth without stopping the client", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { DeepSeekClient } = await import("../../src/deepseek/client.js");
    const client = new DeepSeekClient({
      baseUrl: "https://example.com",
      auth: { token: "old_token_123", cookie: "old_cookie_123" },
      sessionManager: {} as never,
      solver: { solve: async () => ({ answer: 1, signature: "s", algorithm: "a", salt: "", challenge: "" }) } as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
      redactor: { addSecret: () => {}, redactText: (t: string) => t } as never,
      timeoutMs: 10_000,
      maxRetries: 0,
    });

    client.clearAuth();
    expect(client.hasAuth()).toBe(false);
    await expect(client.ensureSession({ chatSessionId: null, parentMessageId: null, history: [], updatedAt: 0 }))
      .rejects.toMatchObject({ code: "AUTH_MISSING", status: 401 });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("uses newly captured credentials after logout without a restart", async () => {
    let capturedHeaders: Record<string, string> = {};
    const mock = mockFetch(async (_url, init) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ data: { biz_data: { chat_session: { id: "sess_new" } } } }), { status: 200 });
    });

    try {
      const { DeepSeekClient } = await import("../../src/deepseek/client.js");
      const client = new DeepSeekClient({
        baseUrl: "https://example.com",
        auth: { token: "old_token_123", cookie: "old_cookie_123" },
        sessionManager: {} as never,
        solver: { solve: async () => ({ answer: 1, signature: "s", algorithm: "a", salt: "", challenge: "" }) } as never,
        logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
        redactor: { addSecret: () => {}, redactText: (t: string) => t } as never,
        timeoutMs: 10_000,
        maxRetries: 0,
      });

      client.clearAuth();
      client.setAuth({ token: "new_token_456", cookie: "new_cookie_456", hifLeim: "new_hif_456" });
      await client.ensureSession({ chatSessionId: null, parentMessageId: null, history: [], updatedAt: 0 });

      expect(capturedHeaders.authorization).toBe("Bearer new_token_456");
      expect(capturedHeaders.cookie).toBe("new_cookie_456");
      expect(capturedHeaders["x-hif-leim"]).toBe("new_hif_456");
      expect(JSON.stringify(capturedHeaders)).not.toContain("old_token_123");
    } finally {
      mock.restore();
    }
  });

  it("rejects an in-flight old-account session result after credentials change", async () => {
    let resolveFetch!: (response: Response) => void;
    const mock = mockFetch(async () => new Promise<Response>(resolve => { resolveFetch = resolve; }));

    try {
      const { DeepSeekClient } = await import("../../src/deepseek/client.js");
      const client = new DeepSeekClient({
        baseUrl: "https://example.com",
        auth: { token: "old_token_123", cookie: "old_cookie_123" },
        sessionManager: {} as never,
        solver: { solve: async () => ({ answer: 1, signature: "s", algorithm: "a", salt: "", challenge: "" }) } as never,
        logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
        redactor: { addSecret: () => {}, redactText: (t: string) => t } as never,
        timeoutMs: 10_000,
        maxRetries: 0,
      });
      const state = { chatSessionId: null, parentMessageId: null, history: [], updatedAt: 0 };
      const oldGeneration = client.getAuthGeneration();
      const pending = client.ensureSession(state, oldGeneration);
      await vi.waitFor(() => expect(resolveFetch).toBeTypeOf("function"));

      client.clearAuth();
      client.setAuth({ token: "new_token_456", cookie: "new_cookie_456" });
      resolveFetch(new Response(JSON.stringify({ data: { biz_data: { chat_session: { id: "old_session" } } } }), { status: 200 }));

      await expect(pending).rejects.toMatchObject({ code: "SESSION_CONFLICT", status: 409 });
      expect(state.chatSessionId).toBeNull();
    } finally {
      mock.restore();
    }
  });
});

describe("app.ts loadAuthFile camelCase with legacy fallback", () => {
  it("reads camelCase hifLeim/hifDliq from auth file shape", () => {
    const raw = { token: "tok", cookie: "c", hifLeim: "camel_leim", hifDliq: "camel_dliq" };
    const hifLeim = typeof raw.hifLeim === "string" ? raw.hifLeim : undefined;
    const hifDliq = typeof raw.hifDliq === "string" ? raw.hifDliq : undefined;
    expect(hifLeim).toBe("camel_leim");
    expect(hifDliq).toBe("camel_dliq");
  });

  it("falls back to legacy hif_leim/hif_dliq when camelCase absent", () => {
    const raw = { token: "tok", cookie: "c", hif_leim: "legacy_leim", hif_dliq: "legacy_dliq" } as Record<string, unknown>;
    const hifLeim = typeof raw.hifLeim === "string" ? raw.hifLeim
      : typeof raw.hif_leim === "string" ? raw.hif_leim : undefined;
    const hifDliq = typeof raw.hifDliq === "string" ? raw.hifDliq
      : typeof raw.hif_dliq === "string" ? raw.hif_dliq : undefined;
    expect(hifLeim).toBe("legacy_leim");
    expect(hifDliq).toBe("legacy_dliq");
  });

  it("camelCase takes priority over legacy", () => {
    const raw = { token: "tok", cookie: "c", hifLeim: "camel", hif_leim: "legacy", hifDliq: "camel2", hif_dliq: "legacy2" } as Record<string, unknown>;
    const hifLeim = typeof raw.hifLeim === "string" ? raw.hifLeim
      : typeof raw.hif_leim === "string" ? raw.hif_leim : undefined;
    const hifDliq = typeof raw.hifDliq === "string" ? raw.hifDliq
      : typeof raw.hif_dliq === "string" ? raw.hif_dliq : undefined;
    expect(hifLeim).toBe("camel");
    expect(hifDliq).toBe("camel2");
  });

  it("returns undefined when neither camelCase nor legacy present", () => {
    const raw = { token: "tok", cookie: "c" } as Record<string, unknown>;
    const hifLeim = typeof raw.hifLeim === "string" ? raw.hifLeim
      : typeof raw.hif_leim === "string" ? raw.hif_leim : undefined;
    const hifDliq = typeof raw.hifDliq === "string" ? raw.hifDliq
      : typeof raw.hif_dliq === "string" ? raw.hif_dliq : undefined;
    expect(hifLeim).toBeUndefined();
    expect(hifDliq).toBeUndefined();
  });
});
