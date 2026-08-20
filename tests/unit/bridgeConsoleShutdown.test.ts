import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return { ...actual, spawn: vi.fn() };
});

vi.mock("../../src/server/actions.js", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    performLogout: vi.fn(),
    stopLaunchedProcesses: vi.fn(),
    stopActiveAuthChrome: vi.fn(),
    runAuthSSE: vi.fn(),
    checkAuthStatus: vi.fn(),
  };
});

import { performLogout, stopLaunchedProcesses, stopActiveAuthChrome, runAuthSSE, checkAuthStatus, pickFolder } from "../../src/server/actions.js";
import { routes } from "../../src/server/routes.js";
import * as child_process from "node:child_process";

function mockChild(stdout = "") {
  const child = new EventEmitter() as any;
  child.pid = 12345;
  const out = new PassThrough();
  child.stdout = out;
  process.nextTick(() => {
    if (stdout) out.write(stdout);
    out.end();
    child.emit("close", 0);
  });
  return child;
}

function mockRes() {
  const res = new EventEmitter() as any;
  res.writeHead = vi.fn();
  res.end = vi.fn();
  res.write = vi.fn();
  res.writableEnded = false;
  return res;
}

function mockCtx(gracefulStop?: () => Promise<void>) {
  return {
    security: { proxyApiKey: "", corsOrigins: [], maxBytes: 1024, loopback: true },
    handler: {} as any,
    sessions: {} as any,
    logger: {
      withRequestRef: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
      info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    } as any,
    redactor: {} as any,
    models: [] as any,
    ready: () => true,
    gracefulStop: gracefulStop ?? vi.fn(async () => {}),
    setRuntimeAuth: vi.fn(async () => {}),
    clearRuntimeAuth: vi.fn(async () => {}),
  };
}

describe("pickFolder cancel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns cancelled=true when PowerShell dialog is cancelled", async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    vi.mocked(child_process.spawn).mockReturnValue(mockChild(""));
    try {
      const r = await pickFolder();
      expect(r).toEqual({ path: null, cancelled: true, supported: true });
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });
});

describe("/bridge/logout on failure", () => {
  let exitSpy: any;
  beforeEach(() => {
    vi.mocked(performLogout).mockReset();
    vi.mocked(stopLaunchedProcesses).mockReset();
    vi.mocked(stopActiveAuthChrome).mockReset();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });
  afterEach(() => { exitSpy.mockRestore(); vi.restoreAllMocks(); });

  it("returns 500, does not call gracefulStop or process.exit", async () => {
    vi.mocked(stopLaunchedProcesses).mockResolvedValue();
    vi.mocked(stopActiveAuthChrome).mockResolvedValue();
    vi.mocked(performLogout).mockResolvedValue({ ok: false, message: "fs error" });

    const gs = vi.fn(async () => {});
    const ctx = mockCtx(gs);
    const handler = routes(ctx as any).find(r => r.path === "/bridge/logout")!.handler;
    const res = mockRes();

    await handler(new EventEmitter() as any, res, "ref");

    expect(res.writeHead).toHaveBeenCalledWith(500, { "content-type": "application/json" });
    expect(gs).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stopLaunchedProcesses).not.toHaveBeenCalled();
  });
});

describe("/bridge/logout", () => {
  let exitSpy: any;

  beforeEach(() => {
    vi.mocked(performLogout).mockReset();
    vi.mocked(stopLaunchedProcesses).mockReset();
    vi.mocked(stopActiveAuthChrome).mockReset();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });
  afterEach(() => { exitSpy.mockRestore(); vi.restoreAllMocks(); });

  it("clears runtime auth but keeps the server and launched CLIs running", async () => {
    vi.mocked(stopActiveAuthChrome).mockResolvedValue();
    vi.mocked(performLogout).mockResolvedValue({ ok: true, message: "Logged out" });
    const gs = vi.fn(async () => {});
    const ctx = mockCtx(gs);
    const handler = routes(ctx as any).find(r => r.path === "/bridge/logout")!.handler;
    const res = mockRes();

    await handler(new EventEmitter() as any, res, "ref");

    expect(res.writeHead).toHaveBeenCalledWith(200, { "content-type": "application/json" });
    expect(ctx.clearRuntimeAuth).toHaveBeenCalledOnce();
    expect(stopActiveAuthChrome).toHaveBeenCalledOnce();
    expect(stopLaunchedProcesses).not.toHaveBeenCalled();
    expect(gs).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("/bridge/auth", () => {
  beforeEach(() => {
    vi.mocked(runAuthSSE).mockReset();
    vi.mocked(checkAuthStatus).mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("installs newly captured credentials into the running client before completing", async () => {
    const captured = { token: "new_token_123", cookie: "new_cookie_123", hifLeim: "new_hif_123" };
    vi.mocked(checkAuthStatus).mockResolvedValue({ valid: false, message: "NO AUTH" });
    vi.mocked(runAuthSSE).mockResolvedValue(captured);
    const ctx = mockCtx();
    const handler = routes(ctx as any).find(r => r.path === "/bridge/auth")!.handler;
    const res = mockRes();

    await handler(new EventEmitter() as any, res, "ref");

    expect(ctx.setRuntimeAuth).toHaveBeenCalledWith(captured);
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('"message":"Auth saved"'));
  });
});

describe("/bridge/shutdown", () => {
  let exitSpy: any;
  beforeEach(() => {
    vi.mocked(stopLaunchedProcesses).mockReset();
    vi.mocked(stopActiveAuthChrome).mockReset();
    vi.mocked(performLogout).mockReset();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });
  afterEach(() => { exitSpy.mockRestore(); vi.restoreAllMocks(); });

  it("calls stopLaunchedProcesses, gracefulStop, then process.exit", async () => {
    vi.mocked(stopLaunchedProcesses).mockResolvedValue();
    vi.mocked(stopActiveAuthChrome).mockResolvedValue();
    const gs = vi.fn(async () => {});
    const ctx = mockCtx(gs);
    const handler = routes(ctx as any).find(r => r.path === "/bridge/shutdown")!.handler;
    const res = mockRes();

    await handler(new EventEmitter() as any, res, "ref");

    expect(res.writeHead).toHaveBeenCalledWith(200, { "content-type": "application/json" });
    expect(stopLaunchedProcesses).toHaveBeenCalledOnce();
    expect(stopActiveAuthChrome).toHaveBeenCalledOnce();
    expect(performLogout).not.toHaveBeenCalled();

    await new Promise(r => setTimeout(r, 700));

    expect(gs).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
