import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { BridgeError } from "../../src/utils/errors.js";
import { SessionStore } from "../../src/sessions/sessionStore.js";
import { LineageStore } from "../../src/sessions/lineage.js";
import { CompletionHandler } from "../../src/api/handler.js";
import type { CanonicalRequest } from "../../src/api/canonical.js";
import type { DeepSeekClient } from "../../src/deepseek/client.js";

type FetchFn = typeof globalThis.fetch;

function mockFetch(fn: (...args: Parameters<FetchFn>) => Promise<Response>): { restore: () => void } {
  const prev = globalThis.fetch;
  const wrapped: FetchFn = ((...args: unknown[]) => fn(...(args as Parameters<FetchFn>))) as FetchFn;
  globalThis.fetch = wrapped;
  return { restore: () => { globalThis.fetch = prev; } };
}

function httpError(status: number): Response {
  return new Response("Unauthorized", { status });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fakeOptions() {
  return {
    baseUrl: "https://chat.deepseek.com",
    auth: { token: "tok_abc123", cookie: "ds_session=xyz" },
    sessionManager: {} as never,
    solver: { solve: async () => ({ answer: 1, signature: "s", algorithm: "a", salt: "", challenge: "" }) } as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    redactor: { addSecret: () => {}, redactText: (t: string) => t } as never,
    timeoutMs: 10_000,
    maxRetries: 0,
  };
}

const CHALLENGE_RESPONSE = {
  code: 0,
  data: {
    biz_code: 0,
    biz_data: {
      challenge: {
        target_path: "/api/v0/chat/completion",
        signature: "sig_abc",
        salt: "salt_def",
        challenge: "chal_001",
        algorithm: "DeepSeekHashV1",
        complexity: 3,
        difficulty: 1,
        expire_at: Date.now() + 60_000,
      },
    },
  },
};

const SESSION_CREATE_RESPONSE = {
  code: 0,
  data: { biz_code: 0, biz_data: { id: "sess_001", chat_session: { id: "sess_001" } } },
};

function fakeRequest(): CanonicalRequest {
  return { model: "deepseek-reasoner", stream: false, system: "", messages: [], tools: [], reasoning: true, search: false };
}

function fakeStream() {
  return { start: () => {}, push: () => {}, finish: () => {} };
}

const logger = { info: () => {}, warn: () => {}, error: () => {} } as never;

/* ═══ 1. ensureSession 401/403 ═══ */

describe("DeepSeekClient.ensureSession - 401/403", () => {
  let tracker: ReturnType<typeof mockFetch>;
  afterEach(() => { tracker?.restore(); });

  it("401 on session create -> DEEPSEEK_HTTP_401", async () => {
    tracker = mockFetch(async () => httpError(401));
    const { DeepSeekClient } = await import("../../src/deepseek/client.js");
    const client = new DeepSeekClient(fakeOptions());
    const state = { chatSessionId: null, parentMessageId: null, history: [], updatedAt: 0 };
    await expect(client.ensureSession(state)).rejects.toMatchObject({ code: "DEEPSEEK_HTTP_401", status: 401 });
    expect(state.chatSessionId).toBeNull();
  });

  it("403 on session create -> DEEPSEEK_HTTP_403", async () => {
    tracker = mockFetch(async () => httpError(403));
    const { DeepSeekClient } = await import("../../src/deepseek/client.js");
    const client = new DeepSeekClient(fakeOptions());
    const state = { chatSessionId: null, parentMessageId: null, history: [], updatedAt: 0 };
    await expect(client.ensureSession(state)).rejects.toMatchObject({ code: "DEEPSEEK_HTTP_403", status: 403 });
  });
});

/* ═══ 2. fetchChallenge 401/403 ═══ */

describe("DeepSeekClient.fetchChallenge via complete - 401/403", () => {
  let tracker: ReturnType<typeof mockFetch>;
  afterEach(() => { tracker?.restore(); });

  it("401 on challenge -> DEEPSEEK_HTTP_401", async () => {
    tracker = mockFetch(async () => httpError(401));
    const { DeepSeekClient } = await import("../../src/deepseek/client.js");
    const client = new DeepSeekClient(fakeOptions());
    const state = { chatSessionId: "sess_001", parentMessageId: null, history: [], updatedAt: 0 };
    await expect(client.complete(fakeRequest(), state)).rejects.toMatchObject({ code: "DEEPSEEK_HTTP_401", status: 401 });
  });

  it("403 on challenge -> DEEPSEEK_HTTP_403", async () => {
    tracker = mockFetch(async () => httpError(403));
    const { DeepSeekClient } = await import("../../src/deepseek/client.js");
    const client = new DeepSeekClient(fakeOptions());
    const state = { chatSessionId: "sess_001", parentMessageId: null, history: [], updatedAt: 0 };
    await expect(client.complete(fakeRequest(), state)).rejects.toMatchObject({ code: "DEEPSEEK_HTTP_403", status: 403 });
  });
});

/* ═══ 3. completion 401/403 ═══ */

describe("DeepSeekClient.complete - 401/403 on completion", () => {
  let tracker: ReturnType<typeof mockFetch>;
  afterEach(() => { tracker?.restore(); });

  it("401 on completion -> DEEPSEEK_HTTP_401 with runtime re-auth guidance", async () => {
    let callCount = 0;
    tracker = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return jsonResponse(CHALLENGE_RESPONSE);
      return httpError(401);
    });
    const { DeepSeekClient } = await import("../../src/deepseek/client.js");
    const client = new DeepSeekClient(fakeOptions());
    const state = { chatSessionId: "sess_001", parentMessageId: null, history: [], updatedAt: 0 };
    try {
      await client.complete(fakeRequest(), state);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BridgeError);
      expect((e as BridgeError).code).toBe("DEEPSEEK_HTTP_401");
      expect((e as BridgeError).message).toContain("AUTH in Bridge Console");
      expect((e as BridgeError).message).toContain("npm run auth");
      expect((e as BridgeError).message).not.toContain("restart Bridge");
      expect((e as BridgeError).message).not.toContain("tok_abc");
    }
  });

  it("403 on completion -> DEEPSEEK_HTTP_403", async () => {
    let callCount = 0;
    tracker = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return jsonResponse(CHALLENGE_RESPONSE);
      return httpError(403);
    });
    const { DeepSeekClient } = await import("../../src/deepseek/client.js");
    const client = new DeepSeekClient(fakeOptions());
    const state = { chatSessionId: "sess_001", parentMessageId: null, history: [], updatedAt: 0 };
    try {
      await client.complete(fakeRequest(), state);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BridgeError);
      expect((e as BridgeError).code).toBe("DEEPSEEK_HTTP_403");
    }
  });

  it("other errors do not use auth error code", async () => {
    let callCount = 0;
    tracker = mockFetch(async () => {
      callCount++;
      if (callCount === 1) return jsonResponse(CHALLENGE_RESPONSE);
      return httpError(500);
    });
    const { DeepSeekClient } = await import("../../src/deepseek/client.js");
    const client = new DeepSeekClient(fakeOptions());
    const state = { chatSessionId: "sess_001", parentMessageId: null, history: [], updatedAt: 0 };
    try {
      await client.complete(fakeRequest(), state);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(BridgeError);
      expect((e as BridgeError).code).not.toBe("DEEPSEEK_HTTP_401");
      expect((e as BridgeError).code).not.toBe("DEEPSEEK_HTTP_403");
    }
  });
});

/* ═══ 4. LineageStore.removeByUpstreamKey ═══ */

describe("LineageStore.removeByUpstreamKey", () => {
  it("removes all links matching upstreamKey", async () => {
    const tmpFile = `/tmp/lineage_test_${Date.now()}.json`;
    const store = new LineageStore(tmpFile);
    await store.record("call_1", "upstream_A");
    await store.record("call_2", "upstream_A");
    await store.record("call_3", "upstream_B");
    expect(store.getUpstreamKey("call_1")).toBe("upstream_A");
    expect(store.getUpstreamKey("call_3")).toBe("upstream_B");

    await store.removeByUpstreamKey("upstream_A");
    expect(store.getUpstreamKey("call_1")).toBeUndefined();
    expect(store.getUpstreamKey("call_2")).toBeUndefined();
    expect(store.getUpstreamKey("call_3")).toBe("upstream_B");
  });

  it("no-op when upstreamKey has no links", async () => {
    const tmpFile = `/tmp/lineage_test_${Date.now()}.json`;
    const store = new LineageStore(tmpFile);
    await store.record("call_1", "upstream_A");
    await store.removeByUpstreamKey("nonexistent");
    expect(store.getUpstreamKey("call_1")).toBe("upstream_A");
  });
});

/* ═══ 5. CompletionHandler — 401/403 resets ═══ */

describe("CompletionHandler - auth expired resets", () => {
  let sessionStore: SessionStore;
  let lineage: LineageStore;

  beforeEach(async () => {
    sessionStore = new SessionStore();
    lineage = new LineageStore(`/tmp/lineage_handler_test_${Date.now()}.json`);
    await lineage.init();
  });

  function makeHandler(deepseek: unknown) {
    return new CompletionHandler({ deepseek: deepseek as DeepSeekClient, sessionStore, lineage, logger });
  }

  it("401 on ensureSession resets session and lineage", async () => {
    const error = new BridgeError(
      "DeepSeek authorization expired (HTTP 401). Use AUTH in Bridge Console, or run `npm run auth`.",
      { code: "DEEPSEEK_HTTP_401", status: 401 },
    );
    const handler = makeHandler({
      ensureSession: async () => { throw error; },
      complete: async () => { throw error; },
    });

    const upstreamKey = "test_upstream";
    const state = sessionStore.getOrCreate(upstreamKey);
    state.chatSessionId = "sess_to_reset";
    state.parentMessageId = 42;
    state.history.push({ role: "user", content: "test" });
    await lineage.record("call_to_clean", upstreamKey);

    const request = fakeRequest();
    request.messages = [{ role: "user", parts: [{ type: "text", text: "test" }] }];

    try {
      await handler.run({
        protocol: "anthropic" as never,
        request,
        headers: { "x-claude-code-session-id": "test_client" },
        body: { metadata: { user_id: upstreamKey } },
        stream: fakeStream() as never,
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as BridgeError).code).toBe("DEEPSEEK_HTTP_401");
    }

    expect(sessionStore.get(upstreamKey)).toBeUndefined();
    expect(lineage.getUpstreamKey("call_to_clean")).toBeUndefined();
  });

  it("403 on ensureSession resets session and lineage", async () => {
    const error = new BridgeError(
      "DeepSeek authorization expired (HTTP 403). Use AUTH in Bridge Console, or run `npm run auth`.",
      { code: "DEEPSEEK_HTTP_403", status: 403 },
    );
    const handler = makeHandler({
      ensureSession: async () => { throw error; },
      complete: async () => { throw error; },
    });

    const upstreamKey = "test_upstream_403";
    const state = sessionStore.getOrCreate(upstreamKey);
    state.chatSessionId = "sess_to_reset_403";
    await lineage.record("call_y1", upstreamKey);
    await lineage.record("call_y2", upstreamKey);

    const request = fakeRequest();
    request.messages = [{ role: "user", parts: [{ type: "text", text: "test" }] }];

    try {
      await handler.run({
        protocol: "anthropic" as never,
        request,
        headers: { "x-claude-code-session-id": "test_client_403" },
        body: { metadata: { user_id: upstreamKey } },
        stream: fakeStream() as never,
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as BridgeError).code).toBe("DEEPSEEK_HTTP_403");
    }

    expect(sessionStore.get(upstreamKey)).toBeUndefined();
    expect(lineage.getUpstreamKey("call_y1")).toBeUndefined();
    expect(lineage.getUpstreamKey("call_y2")).toBeUndefined();
  });

  it("401 on complete resets session and lineage", async () => {
    const handler = makeHandler({
      ensureSession: async (state: { chatSessionId: string | null }) => { state.chatSessionId = "sess_001"; },
      complete: async () => {
        throw new BridgeError(
          "DeepSeek authorization expired (HTTP 401). Use AUTH in Bridge Console, or run `npm run auth`.",
          { code: "DEEPSEEK_HTTP_401", status: 401 },
        );
      },
    });

    const upstreamKey = "test_upstream_z";
    const state = sessionStore.getOrCreate(upstreamKey);
    state.chatSessionId = "sess_z";
    await lineage.record("call_z1", upstreamKey);

    const request = fakeRequest();
    request.messages = [{ role: "user", parts: [{ type: "text", text: "test" }] }];

    try {
      await handler.run({
        protocol: "anthropic" as never,
        request,
        headers: { "x-claude-code-session-id": "test_client_z" },
        body: { metadata: { user_id: upstreamKey } },
        stream: fakeStream() as never,
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as BridgeError).code).toBe("DEEPSEEK_HTTP_401");
    }

    expect(sessionStore.get(upstreamKey)).toBeUndefined();
    expect(lineage.getUpstreamKey("call_z1")).toBeUndefined();
  });

  it("500 on complete does NOT reset session or lineage", async () => {
    const handler = makeHandler({
      ensureSession: async (state: { chatSessionId: string | null }) => { state.chatSessionId = "sess_w"; },
      complete: async () => {
        throw new BridgeError("Upstream error HTTP 500: internal", { code: "UPSTREAM_ERROR", status: 500, retryable: true });
      },
    });

    const upstreamKey = "test_upstream_w";
    const state = sessionStore.getOrCreate(upstreamKey);
    state.chatSessionId = "sess_w";
    await lineage.record("call_w1", upstreamKey);

    const request = fakeRequest();
    request.messages = [{ role: "user", parts: [{ type: "text", text: "test" }] }];

    try {
      await handler.run({
        protocol: "anthropic" as never,
        request,
        headers: { "x-claude-code-session-id": "test_client_w" },
        body: { metadata: { user_id: upstreamKey } },
        stream: fakeStream() as never,
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as BridgeError).code).toBe("UPSTREAM_ERROR");
    }

    expect(sessionStore.get(upstreamKey)).toBeDefined();
    expect(sessionStore.get(upstreamKey)!.chatSessionId).toBe("sess_w");
    expect(lineage.getUpstreamKey("call_w1")).toBe(upstreamKey);
  });

  it("lineage cleaned for upstreamKey with multiple call IDs", async () => {
    const error = new BridgeError(
      "DeepSeek authorization expired (HTTP 401). Use AUTH in Bridge Console, or run `npm run auth`.",
      { code: "DEEPSEEK_HTTP_401", status: 401 },
    );
    const handler = makeHandler({
      ensureSession: async () => { throw error; },
      complete: async () => { throw error; },
    });

    const upstreamKey = "test_upstream_multi";
    sessionStore.getOrCreate(upstreamKey);
    await lineage.record("cid_a", upstreamKey);
    await lineage.record("cid_b", upstreamKey);
    await lineage.record("cid_c", "other_upstream");

    const request = fakeRequest();
    request.messages = [{ role: "user", parts: [{ type: "text", text: "test" }] }];

    try {
      await handler.run({
        protocol: "anthropic" as never,
        request,
        headers: { "x-claude-code-session-id": "test_multi" },
        body: { metadata: { user_id: upstreamKey } },
        stream: fakeStream() as never,
      });
    } catch {}

    expect(sessionStore.get(upstreamKey)).toBeUndefined();
    expect(lineage.getUpstreamKey("cid_a")).toBeUndefined();
    expect(lineage.getUpstreamKey("cid_b")).toBeUndefined();
    expect(lineage.getUpstreamKey("cid_c")).toBe("other_upstream");
  });
});
