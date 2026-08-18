import { describe, expect, it } from "vitest";
import { SessionCreateLimiter } from "../../src/utils/sessionCreateLimiter.js";
import type { UpstreamSessionState } from "../../src/sessions/sessionStore.js";
import { DeepSeekClient } from "../../src/deepseek/client.js";
import type { DeepSeekClientOptions } from "../../src/deepseek/client.js";

describe("SessionCreateLimiter", () => {
  it("serializes concurrent acquire calls", async () => {
    const limiter = new SessionCreateLimiter(50);
    const order: number[] = [];
    const p1 = limiter.acquire().then(() => { order.push(1); });
    const p2 = limiter.acquire().then(() => { order.push(2); });
    const p3 = limiter.acquire().then(() => { order.push(3); });
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("enforces minimum interval between acquires", async () => {
    const limiter = new SessionCreateLimiter(80);
    const timestamps: number[] = [];

    await limiter.acquire();
    timestamps.push(Date.now());
    await limiter.acquire();
    timestamps.push(Date.now());
    await limiter.acquire();
    timestamps.push(Date.now());

    const gap1 = timestamps[1]! - timestamps[0]!;
    const gap2 = timestamps[2]! - timestamps[1]!;
    expect(gap1).toBeGreaterThanOrEqual(60);
    expect(gap2).toBeGreaterThanOrEqual(60);
  });

  it("first acquire does not delay", async () => {
    const limiter = new SessionCreateLimiter(5_000);
    const start = Date.now();
    await limiter.acquire();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });
});

function fakeOptions(): DeepSeekClientOptions {
  return {
    baseUrl: "https://example.com",
    auth: { token: "tok", cookie: "c=1" },
    sessionManager: {} as never,
    solver: { solve: async () => ({ answer: 1, signature: "s", algorithm: "a", salt: "", challenge: "" }) } as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    redactor: { redactText: (t: string) => t } as never,
    timeoutMs: 10_000,
    maxRetries: 0,
  };
}

type FetchFn = typeof globalThis.fetch;

function mockFetch(fn: (...args: Parameters<FetchFn>) => Promise<Response>): { restore: () => void; fn: FetchFn } {
  const prev = globalThis.fetch;
  const wrapped: FetchFn = ((...args: unknown[]) => fn(...(args as Parameters<FetchFn>))) as FetchFn;
  globalThis.fetch = wrapped;
  return { restore: () => { globalThis.fetch = prev; }, fn: wrapped };
}

describe("DeepSeekClient.ensureSession with limiter", () => {
  it("skips create when chatSessionId already set", async () => {
    const client = new DeepSeekClient(fakeOptions());
    const state: UpstreamSessionState = {
      chatSessionId: "existing-session",
      parentMessageId: null,
      history: [],
      updatedAt: 0,
    };
    await client.ensureSession(state);
    expect(state.chatSessionId).toBe("existing-session");
  });

  it("two fast ensureSession calls do not create simultaneously", async () => {
    const creationOrder: string[] = [];
    let fetchCalls = 0;
    const mock = mockFetch(async () => {
      fetchCalls++;
      creationOrder.push(`fetch_${fetchCalls}`);
      return new Response(JSON.stringify({ data: { id: `sess_${fetchCalls}` } }), { status: 200 });
    });

    try {
      const client = new DeepSeekClient(fakeOptions());
      const s1: UpstreamSessionState = { chatSessionId: null, parentMessageId: null, history: [], updatedAt: 0 };
      const s2: UpstreamSessionState = { chatSessionId: null, parentMessageId: null, history: [], updatedAt: 0 };

      const p1 = client.ensureSession(s1);
      const p2 = client.ensureSession(s2);
      await Promise.all([p1, p2]);

      expect(creationOrder[0]).toBe("fetch_1");
      expect(creationOrder[1]).toBe("fetch_2");
      expect(s1.chatSessionId).toBeTruthy();
      expect(s2.chatSessionId).toBeTruthy();
    } finally {
      mock.restore();
    }
  });

  it("limiter enforces interval between session creates", async () => {
    const timestamps: number[] = [];
    const mock = mockFetch(async () => {
      timestamps.push(Date.now());
      return new Response(JSON.stringify({ data: { id: "sess_x" } }), { status: 200 });
    });

    try {
      const client = new DeepSeekClient(fakeOptions());
      const s1: UpstreamSessionState = { chatSessionId: null, parentMessageId: null, history: [], updatedAt: 0 };
      const s2: UpstreamSessionState = { chatSessionId: null, parentMessageId: null, history: [], updatedAt: 0 };

      await client.ensureSession(s1);
      await client.ensureSession(s2);

      const gap = timestamps[1]! - timestamps[0]!;
      expect(gap).toBeGreaterThanOrEqual(1500);
    } finally {
      mock.restore();
    }
  });

  it("does not create new session when chatSessionId exists (no limiter hit)", async () => {
    let fetchCount = 0;
    const mock = mockFetch(async () => {
      fetchCount++;
      return new Response(JSON.stringify({ data: { id: "sess_new" } }), { status: 200 });
    });

    try {
      const client = new DeepSeekClient(fakeOptions());
      const state: UpstreamSessionState = {
        chatSessionId: "already-created",
        parentMessageId: null,
        history: [],
        updatedAt: 0,
      };
      await client.ensureSession(state);
      expect(fetchCount).toBe(0);
      expect(state.chatSessionId).toBe("already-created");
    } finally {
      mock.restore();
    }
  });
});
