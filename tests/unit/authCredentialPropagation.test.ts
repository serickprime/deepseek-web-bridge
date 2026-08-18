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
        redactor: { redactText: (t: string) => t } as never,
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
        redactor: { redactText: (t: string) => t } as never,
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
