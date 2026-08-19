import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

type FetchFn = typeof globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function trackFetch(): {
  restore: () => void;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const prev = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const wrapped: FetchFn = ((...args: unknown[]) => {
    const url = String(args[0]);
    const init = args[1] as RequestInit | undefined;
    calls.push({ url, init });
    if (url.includes("/health")) {
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    return Promise.resolve(jsonResponse({ code: 0 }));
  }) as FetchFn;
  globalThis.fetch = wrapped;
  return {
    calls,
    restore: () => { globalThis.fetch = prev; },
  };
}

/* ── checkAuthStatus: local-only (no upstream HTTP) ── */

describe("checkAuthStatus", () => {
  let tracker: ReturnType<typeof trackFetch>;

  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { tracker?.restore(); vi.restoreAllMocks(); });

  it("returns AUTH SAVED when token+cookie present", async () => {
    tracker = trackFetch();
    vi.doMock("../../src/config/env.js", () => ({
      buildConfig: () => ({ authFile: "auth.json", baseUrl: "https://chat.deepseek.com" }),
    }));
    vi.doMock("../../src/utils/atomicFile.js", () => ({
      readJsonIfExists: async () => ({ token: "tok123", cookie: "sid=abc" }),
    }));
    const { checkAuthStatus } = await import("../../src/server/actions.js");
    const result = await checkAuthStatus();
    expect(result.valid).toBe(true);
    expect(result.message).toMatch(/AUTH SAVED/);
    const httpCalls = tracker.calls.filter(c => c.url.includes("/auth/session"));
    expect(httpCalls).toHaveLength(0);
  });

  it("returns NO AUTH when no auth.json", async () => {
    tracker = trackFetch();
    vi.doMock("../../src/config/env.js", () => ({
      buildConfig: () => ({ authFile: "auth.json", baseUrl: "https://chat.deepseek.com" }),
    }));
    vi.doMock("../../src/utils/atomicFile.js", () => ({
      readJsonIfExists: async () => null,
    }));
    const { checkAuthStatus } = await import("../../src/server/actions.js");
    const result = await checkAuthStatus();
    expect(result.valid).toBe(false);
    expect(result.message).toBe("NO AUTH");
  });

  it("returns NO AUTH when auth.json has no credentials", async () => {
    tracker = trackFetch();
    vi.doMock("../../src/config/env.js", () => ({
      buildConfig: () => ({ authFile: "auth.json", baseUrl: "https://chat.deepseek.com" }),
    }));
    vi.doMock("../../src/utils/atomicFile.js", () => ({
      readJsonIfExists: async () => ({ token: "", cookie: "" }),
    }));
    const { checkAuthStatus } = await import("../../src/server/actions.js");
    const result = await checkAuthStatus();
    expect(result.valid).toBe(false);
    expect(result.message).toBe("NO AUTH");
  });

  it("makes zero HTTP calls", async () => {
    tracker = trackFetch();
    vi.doMock("../../src/config/env.js", () => ({
      buildConfig: () => ({ authFile: "auth.json", baseUrl: "https://chat.deepseek.com" }),
    }));
    vi.doMock("../../src/utils/atomicFile.js", () => ({
      readJsonIfExists: async () => ({ token: "tok123", cookie: "sid=abc" }),
    }));
    const { checkAuthStatus } = await import("../../src/server/actions.js");
    await checkAuthStatus();
    expect(tracker.calls).toHaveLength(0);
  });
});

/* ── runDiagnosticsSSE HIF header forwarding ── */

describe("runDiagnosticsSSE HIF headers", () => {
  let tracker: ReturnType<typeof trackFetch>;

  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { tracker?.restore(); vi.restoreAllMocks(); });

  it("upstream reachability check uses root URL without auth", async () => {
    tracker = trackFetch();
    vi.doMock("../../src/config/env.js", () => ({
      buildConfig: () => ({ authFile: "auth.json", baseUrl: "https://chat.deepseek.com", dataDir: "/tmp/test", port: 9655 }),
    }));
    vi.doMock("../../src/utils/atomicFile.js", () => ({
      readJsonIfExists: async () => ({ token: "tok123", cookie: "sid=abc", hifLeim: "diag-leim" }),
    }));
    const { runDiagnosticsSSE } = await import("../../src/server/actions.js");
    await runDiagnosticsSSE(() => {});
    const upstreamCall = tracker.calls.find(c => c.url === "https://chat.deepseek.com");
    expect(upstreamCall).toBeDefined();
    const headers = upstreamCall!.init?.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBeUndefined();
    expect(headers?.cookie).toBeUndefined();
  });

  it("upstream reachability check does not send x-hif-leim", async () => {
    tracker = trackFetch();
    vi.doMock("../../src/config/env.js", () => ({
      buildConfig: () => ({ authFile: "auth.json", baseUrl: "https://chat.deepseek.com", dataDir: "/tmp/test", port: 9655 }),
    }));
    vi.doMock("../../src/utils/atomicFile.js", () => ({
      readJsonIfExists: async () => ({ token: "tok123", cookie: "sid=abc", hifLeim: "diag-leim" }),
    }));
    const { runDiagnosticsSSE } = await import("../../src/server/actions.js");
    await runDiagnosticsSSE(() => {});
    const upstreamCall = tracker.calls.find(c => c.url === "https://chat.deepseek.com");
    expect(upstreamCall).toBeDefined();
    const headers = upstreamCall!.init?.headers as Record<string, string> | undefined;
    expect(headers?.["x-hif-leim"]).toBeUndefined();
  });

  it("upstream reachability check does not send x-hif-dliq from legacy key", async () => {
    tracker = trackFetch();
    vi.doMock("../../src/config/env.js", () => ({
      buildConfig: () => ({ authFile: "auth.json", baseUrl: "https://chat.deepseek.com", dataDir: "/tmp/test", port: 9655 }),
    }));
    vi.doMock("../../src/utils/atomicFile.js", () => ({
      readJsonIfExists: async () => ({ token: "tok123", cookie: "sid=abc", hif_dliq: "legacy-dliq" }),
    }));
    const { runDiagnosticsSSE } = await import("../../src/server/actions.js");
    await runDiagnosticsSSE(() => {});
    const upstreamCall = tracker.calls.find(c => c.url === "https://chat.deepseek.com");
    expect(upstreamCall).toBeDefined();
    const headers = upstreamCall!.init?.headers as Record<string, string> | undefined;
    expect(headers?.["x-hif-dliq"]).toBeUndefined();
  });
});
