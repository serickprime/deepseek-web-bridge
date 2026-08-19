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

/* ── checkAuthStatus HIF header forwarding ── */

describe("checkAuthStatus HIF headers", () => {
  let tracker: ReturnType<typeof trackFetch>;

  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { tracker?.restore(); vi.restoreAllMocks(); });

  it("sends x-hif-leim from camelCase key", async () => {
    tracker = trackFetch();
    vi.doMock("../../src/config/env.js", () => ({
      buildConfig: () => ({ authFile: "auth.json", baseUrl: "https://chat.deepseek.com" }),
    }));
    vi.doMock("../../src/utils/atomicFile.js", () => ({
      readJsonIfExists: async () => ({ token: "tok123", cookie: "sid=abc", hifLeim: "leim-val" }),
    }));
    const { checkAuthStatus } = await import("../../src/server/actions.js");
    const result = await checkAuthStatus();
    expect(result.valid).toBe(true);
    const call = tracker.calls.find(c => c.url.includes("/auth/session"));
    expect(call).toBeDefined();
    expect((call!.init?.headers as Record<string, string>)["x-hif-leim"]).toBe("leim-val");
  });

  it("sends x-hif-leim from legacy snake_case key", async () => {
    tracker = trackFetch();
    vi.doMock("../../src/config/env.js", () => ({
      buildConfig: () => ({ authFile: "auth.json", baseUrl: "https://chat.deepseek.com" }),
    }));
    vi.doMock("../../src/utils/atomicFile.js", () => ({
      readJsonIfExists: async () => ({ token: "tok123", cookie: "sid=abc", hif_leim: "legacy-leim" }),
    }));
    const { checkAuthStatus } = await import("../../src/server/actions.js");
    await checkAuthStatus();
    const call = tracker.calls.find(c => c.url.includes("/auth/session"));
    expect((call!.init?.headers as Record<string, string>)["x-hif-leim"]).toBe("legacy-leim");
  });

  it("sends x-hif-dliq when present", async () => {
    tracker = trackFetch();
    vi.doMock("../../src/config/env.js", () => ({
      buildConfig: () => ({ authFile: "auth.json", baseUrl: "https://chat.deepseek.com" }),
    }));
    vi.doMock("../../src/utils/atomicFile.js", () => ({
      readJsonIfExists: async () => ({ token: "tok123", cookie: "sid=abc", hifDliq: "dliq-val", hifLeim: "leim-val" }),
    }));
    const { checkAuthStatus } = await import("../../src/server/actions.js");
    await checkAuthStatus();
    const call = tracker.calls.find(c => c.url.includes("/auth/session"));
    const h = call!.init?.headers as Record<string, string>;
    expect(h["x-hif-dliq"]).toBe("dliq-val");
    expect(h["x-hif-leim"]).toBe("leim-val");
  });
});

/* ── runDiagnosticsSSE HIF header forwarding ── */

describe("runDiagnosticsSSE HIF headers", () => {
  let tracker: ReturnType<typeof trackFetch>;

  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { tracker?.restore(); vi.restoreAllMocks(); });

  it("upstream check sends x-hif-leim", async () => {
    tracker = trackFetch();
    vi.doMock("../../src/config/env.js", () => ({
      buildConfig: () => ({ authFile: "auth.json", baseUrl: "https://chat.deepseek.com", dataDir: "/tmp/test", port: 9655 }),
    }));
    vi.doMock("../../src/utils/atomicFile.js", () => ({
      readJsonIfExists: async () => ({ token: "tok123", cookie: "sid=abc", hifLeim: "diag-leim" }),
    }));
    const { runDiagnosticsSSE } = await import("../../src/server/actions.js");
    await runDiagnosticsSSE(() => {});
    const upstreamCall = tracker.calls.find(c => c.url.includes("/auth/session"));
    expect(upstreamCall).toBeDefined();
    expect((upstreamCall!.init?.headers as Record<string, string>)["x-hif-leim"]).toBe("diag-leim");
  });

  it("upstream check sends x-hif-dliq from legacy key", async () => {
    tracker = trackFetch();
    vi.doMock("../../src/config/env.js", () => ({
      buildConfig: () => ({ authFile: "auth.json", baseUrl: "https://chat.deepseek.com", dataDir: "/tmp/test", port: 9655 }),
    }));
    vi.doMock("../../src/utils/atomicFile.js", () => ({
      readJsonIfExists: async () => ({ token: "tok123", cookie: "sid=abc", hif_dliq: "legacy-dliq" }),
    }));
    const { runDiagnosticsSSE } = await import("../../src/server/actions.js");
    await runDiagnosticsSSE(() => {});
    const upstreamCall = tracker.calls.find(c => c.url.includes("/auth/session"));
    expect(upstreamCall).toBeDefined();
    expect((upstreamCall!.init?.headers as Record<string, string>)["x-hif-dliq"]).toBe("legacy-dliq");
  });
});
