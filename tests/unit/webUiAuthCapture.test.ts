import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cdp = vi.hoisted(() => ({
  requestHandler: undefined as ((params: Record<string, unknown>) => void) | undefined,
  killed: false,
  hifValue: '"local-storage-hif"' as string | null,
  emitRequest: true,
  launchResult: undefined as ChildProcess | undefined,
}));

vi.mock("../../src/cdp.js", () => {
  class MockCdpConnection {
    static async connect(): Promise<MockCdpConnection> {
      return new MockCdpConnection();
    }

    async send(method: string): Promise<Record<string, unknown>> {
      if (method === "Runtime.evaluate") {
        return { result: { value: cdp.hifValue } };
      }
      if (method === "Network.getCookies") {
        return { cookies: [{ name: "session", value: "captured-cookie" }] };
      }
      return {};
    }

    on(method: string, callback: (params: Record<string, unknown>) => void): void {
      if (method === "Fetch.requestPaused") {
        cdp.requestHandler = callback;
        if (cdp.emitRequest) {
          callback({
            requestId: "request-1",
            request: {
              url: "https://chat.deepseek.com/api/v0/chat/completion",
              headers: { authorization: "Bearer captured-token" },
            },
          });
        }
      }
    }

    close(): void {}
  }

  return {
    CdpConnection: MockCdpConnection,
    createPage: vi.fn(async () => "ws://test"),
    findChrome: vi.fn(() => "chrome.exe"),
    launchChrome: vi.fn(() => cdp.launchResult),
    waitForDebugger: vi.fn(async () => {}),
  };
});

import { runAuthSSE, stopActiveAuthChrome } from "../../src/server/actions.js";

function fakeChild(pid = 54001): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => {
      cdp.killed = true;
      (child as { exitCode: number | null }).exitCode = 0;
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
      return true;
    }),
    unref: vi.fn(),
  });
  return child;
}

function finishChild(child: ChildProcess, code = 0): void {
  (child as { exitCode: number | null }).exitCode = code;
  child.emit("exit", code, null);
  child.emit("close", code, null);
}

describe("Web UI auth credential capture", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-web-auth-"));
    vi.stubEnv("DS_DATA_DIR", dataDir);
    vi.stubEnv("DS_AUTH_FILE", path.join(dataDir, "auth.json"));
    vi.stubEnv("DS_CHROME_PROFILE", path.join(dataDir, "chrome-profile"));
    cdp.requestHandler = undefined;
    cdp.killed = false;
    cdp.hifValue = '"local-storage-hif"';
    cdp.emitRequest = true;
    cdp.launchResult = fakeChild();
  });

  afterEach(async () => {
    await stopActiveAuthChrome({ isProcessAlive: () => false }).catch(() => {});
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("completes from Bearer plus localStorage HIF when requests have no HIF header", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ code: 0, data: { biz_code: 0 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const events: Array<{ message?: string }> = [];

    const auth = await runAuthSSE(event => events.push(event));

    expect(auth).toEqual({
      token: "captured-token",
      cookie: "session=captured-cookie",
      hifDliq: undefined,
      hifLeim: "local-storage-hif",
    });
    expect(events).toContainEqual(expect.objectContaining({ message: "Credentials captured, finalizing..." }));
    expect(fs.existsSync(path.join(dataDir, "auth.json"))).toBe(true);
    expect(cdp.killed).toBe(true);
  });

  it("accepts verified Bearer and cookie when current DeepSeek provides no HIF", async () => {
    cdp.hifValue = null;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ code: 0, data: { biz_code: 0 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const auth = await runAuthSSE(() => {});

    expect(auth).toEqual({
      token: "captured-token",
      cookie: "session=captured-cookie",
      hifDliq: undefined,
      hifLeim: undefined,
    });
    expect(fs.existsSync(path.join(dataDir, "auth.json"))).toBe(true);
    expect(cdp.killed).toBe(true);
  });

  it("cancels active AUTH without killing Chrome before authoritative Windows tree cleanup", async () => {
    cdp.emitRequest = false;
    const chrome = cdp.launchResult!;
    const helper = fakeChild(54002);
    const alive = new Set([chrome.pid!]);
    const spawnProcess = vi.fn(() => {
      process.nextTick(() => {
        alive.delete(chrome.pid!);
        finishChild(chrome);
        finishChild(helper);
      });
      return helper;
    });
    const authPromise = runAuthSSE(() => {});
    await vi.waitFor(() => expect(cdp.requestHandler).toBeTypeOf("function"));

    await stopActiveAuthChrome({
      platform: "win32",
      timeoutMs: 100,
      isProcessAlive: pid => alive.has(pid),
      spawnProcess: spawnProcess as typeof spawn,
    });

    await expect(authPromise).resolves.toBeNull();
    expect(chrome.kill).not.toHaveBeenCalled();
    expect(spawnProcess).toHaveBeenCalledWith("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
  });

  it("retains active AUTH Chrome ownership when authoritative tree cleanup fails", async () => {
    cdp.emitRequest = false;
    const chrome = cdp.launchResult!;
    const alive = new Set([chrome.pid!]);
    let attempts = 0;
    const spawnProcess = vi.fn(() => {
      const helper = fakeChild(54100 + attempts);
      attempts++;
      process.nextTick(() => {
        if (attempts === 2) {
          alive.delete(chrome.pid!);
          finishChild(chrome);
        }
        finishChild(helper);
      });
      return helper;
    });
    const authPromise = runAuthSSE(() => {});
    await vi.waitFor(() => expect(cdp.requestHandler).toBeTypeOf("function"));

    await expect(stopActiveAuthChrome({
      platform: "win32",
      timeoutMs: 15,
      isProcessAlive: pid => alive.has(pid),
      spawnProcess: spawnProcess as typeof spawn,
    })).rejects.toMatchObject({ code: "SHUTDOWN_INCOMPLETE", causeCode: "target_exit_timeout" });
    expect(chrome.kill).not.toHaveBeenCalled();

    await stopActiveAuthChrome({
      platform: "win32",
      timeoutMs: 100,
      isProcessAlive: pid => alive.has(pid),
      spawnProcess: spawnProcess as typeof spawn,
    });
    await expect(authPromise).resolves.toBeNull();
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it("keeps external request cancellation responsible for its own Chrome cleanup", async () => {
    cdp.emitRequest = false;
    const chrome = cdp.launchResult!;
    const controller = new AbortController();
    const authPromise = runAuthSSE(() => {}, controller.signal);
    await vi.waitFor(() => expect(cdp.requestHandler).toBeTypeOf("function"));

    controller.abort();

    await expect(authPromise).resolves.toBeNull();
    expect(chrome.kill).toHaveBeenCalledOnce();
  });
});
