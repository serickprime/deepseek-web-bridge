import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createShutdownCoordinator } from "../../src/app.js";
import {
  stopActiveAuthChrome,
  stopLaunchedProcesses,
  trackAuthProcess,
  trackProcess,
} from "../../src/server/actions.js";
import { BridgeError } from "../../src/utils/errors.js";

interface FakeChild extends ChildProcess {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(pid: number, killImpl: () => boolean = () => true): FakeChild {
  const child = new EventEmitter() as FakeChild;
  Object.assign(child, {
    pid,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(killImpl),
    unref: vi.fn(),
  });
  return child;
}

function finishChild(child: FakeChild, code = 0): void {
  child.exitCode = code;
  child.emit("exit", code, null);
  child.emit("close", code, null);
}

function helperChild(pid = 50000): FakeChild {
  return fakeChild(pid);
}

async function expectShutdownCause(promise: Promise<void>, causeCode: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    code: "SHUTDOWN_INCOMPLETE",
    causeCode,
  });
}

afterEach(async () => {
  await stopLaunchedProcesses({
    platform: "win32",
    timeoutMs: 1,
    isProcessAlive: () => false,
  }).catch(() => {});
  await stopActiveAuthChrome({
    platform: "win32",
    timeoutMs: 1,
    isProcessAlive: () => false,
  }).catch(() => {});
});

describe("Windows owned process termination", () => {
  it("accepts taskkill success only after the target exits", async () => {
    const target = fakeChild(51001);
    const alive = new Set([target.pid!]);
    const helper = helperChild();
    const spawnProcess = vi.fn(() => {
      process.nextTick(() => {
        alive.delete(target.pid!);
        finishChild(target);
        finishChild(helper);
      });
      return helper;
    });
    trackProcess(target);

    await stopLaunchedProcesses({
      platform: "win32",
      timeoutMs: 100,
      spawnProcess: spawnProcess as never,
      isProcessAlive: pid => alive.has(pid),
    });

    expect(spawnProcess).toHaveBeenCalledWith("taskkill", ["/PID", "51001", "/T", "/F"], { stdio: "ignore" });
  });

  it("rejects taskkill non-zero while the target is still alive", async () => {
    const target = fakeChild(51002);
    const helper = helperChild();
    const spawnProcess = vi.fn(() => {
      process.nextTick(() => {
        helper.exitCode = 1;
        helper.emit("close", 1, null);
      });
      return helper;
    });
    trackProcess(target);

    await expectShutdownCause(stopLaunchedProcesses({
      platform: "win32",
      timeoutMs: 20,
      spawnProcess: spawnProcess as never,
      isProcessAlive: () => true,
    }), "taskkill_nonzero");

    finishChild(target);
  });

  it("normalizes taskkill spawn error", async () => {
    const target = fakeChild(51003);
    const helper = helperChild();
    const spawnProcess = vi.fn(() => {
      process.nextTick(() => helper.emit("error", new Error("synthetic")));
      return helper;
    });
    trackProcess(target);

    await expectShutdownCause(stopLaunchedProcesses({
      platform: "win32",
      timeoutMs: 20,
      spawnProcess: spawnProcess as never,
      isProcessAlive: () => true,
    }), "taskkill_spawn_failed");

    finishChild(target);
  });

  it("bounds a hanging taskkill helper and kills only that helper", async () => {
    const target = fakeChild(51004);
    const helper = helperChild();
    const spawnProcess = vi.fn(() => helper);
    trackProcess(target);

    await expectShutdownCause(stopLaunchedProcesses({
      platform: "win32",
      timeoutMs: 15,
      spawnProcess: spawnProcess as never,
      isProcessAlive: () => true,
    }), "taskkill_timeout");

    expect(helper.kill).toHaveBeenCalledOnce();
    expect(target.kill).not.toHaveBeenCalled();
    finishChild(target);
  });

  it("treats an already exited target as idempotent success", async () => {
    const target = fakeChild(51005);
    finishChild(target);
    const spawnProcess = vi.fn();
    trackProcess(target);

    await stopLaunchedProcesses({
      platform: "win32",
      timeoutMs: 20,
      spawnProcess: spawnProcess as never,
      isProcessAlive: () => false,
    });

    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("rejects helper success when the target never exits", async () => {
    const target = fakeChild(51006);
    const helper = helperChild();
    const spawnProcess = vi.fn(() => {
      process.nextTick(() => finishChild(helper));
      return helper;
    });
    trackProcess(target);

    await expectShutdownCause(stopLaunchedProcesses({
      platform: "win32",
      timeoutMs: 15,
      spawnProcess: spawnProcess as never,
      isProcessAlive: () => true,
    }), "target_exit_timeout");

    finishChild(target);
  });

  it("retains ownership after failure so a later cleanup can retry", async () => {
    const target = fakeChild(51007);
    const alive = new Set([target.pid!]);
    let attempt = 0;
    const spawnProcess = vi.fn(() => {
      const helper = helperChild(50000 + attempt);
      attempt++;
      process.nextTick(() => {
        if (attempt === 1) {
          helper.exitCode = 1;
          helper.emit("close", 1, null);
        } else {
          alive.delete(target.pid!);
          finishChild(target);
          finishChild(helper);
        }
      });
      return helper;
    });
    trackProcess(target);

    await expectShutdownCause(stopLaunchedProcesses({
      platform: "win32",
      timeoutMs: 15,
      spawnProcess: spawnProcess as never,
      isProcessAlive: pid => alive.has(pid),
    }), "taskkill_nonzero");
    await stopLaunchedProcesses({
      platform: "win32",
      timeoutMs: 100,
      spawnProcess: spawnProcess as never,
      isProcessAlive: pid => alive.has(pid),
    });

    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });
});

describe("Unix tracked child termination", () => {
  it("waits for Linux SIGTERM exit", async () => {
    const target = fakeChild(52001, () => {
      process.nextTick(() => finishChild(target));
      return true;
    });
    trackProcess(target);

    await stopLaunchedProcesses({ platform: "linux", timeoutMs: 100, isProcessAlive: () => true });

    expect(target.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("reports Linux signal failure", async () => {
    const target = fakeChild(52002, () => false);
    trackProcess(target);

    await expectShutdownCause(stopLaunchedProcesses({
      platform: "linux",
      timeoutMs: 15,
      isProcessAlive: () => true,
    }), "signal_send_failed");

    finishChild(target);
  });

  it("reports Linux target exit timeout", async () => {
    const target = fakeChild(52003, () => true);
    trackProcess(target);

    await expectShutdownCause(stopLaunchedProcesses({
      platform: "linux",
      timeoutMs: 15,
      isProcessAlive: () => true,
    }), "target_exit_timeout");

    finishChild(target);
  });
});

describe("active auth Chrome ownership", () => {
  it("keeps Chrome tracked until taskkill and real exit complete", async () => {
    const chrome = fakeChild(53001);
    const alive = new Set([chrome.pid!]);
    const helper = helperChild();
    trackAuthProcess(chrome);

    await stopActiveAuthChrome({
      platform: "win32",
      timeoutMs: 100,
      isProcessAlive: pid => alive.has(pid),
      spawnProcess: vi.fn(() => {
        process.nextTick(() => {
          alive.delete(chrome.pid!);
          finishChild(chrome);
          finishChild(helper);
        });
        return helper;
      }) as never,
    });

    expect(chrome.exitCode).toBe(0);
  });

  it("retains auth Chrome ownership when termination is not confirmed", async () => {
    const chrome = fakeChild(53002);
    const alive = new Set([chrome.pid!]);
    let attempts = 0;
    trackAuthProcess(chrome);
    const spawnProcess = vi.fn(() => {
      const helper = helperChild(53100 + attempts);
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

    await expectShutdownCause(stopActiveAuthChrome({
      platform: "win32",
      timeoutMs: 15,
      isProcessAlive: pid => alive.has(pid),
      spawnProcess: spawnProcess as never,
    }), "target_exit_timeout");
    await stopActiveAuthChrome({
      platform: "win32",
      timeoutMs: 100,
      isProcessAlive: pid => alive.has(pid),
      spawnProcess: spawnProcess as never,
    });

    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });
});

describe("app.stop shutdown coordinator", () => {
  it("starts server, launched process, and auth cleanup once", async () => {
    const calls: string[] = [];
    const stop = createShutdownCoordinator({
      stopServer: vi.fn(async () => { calls.push("server"); }),
      stopLaunched: vi.fn(async () => { calls.push("launched"); }),
      stopAuth: vi.fn(async () => { calls.push("auth"); }),
      timeoutMs: 100,
    });

    await stop();

    expect(calls).toEqual(["server", "launched", "auth"]);
  });

  it("returns one promise for concurrent and repeated calls", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const stopServer = vi.fn(() => gate);
    const stopLaunched = vi.fn(async () => {});
    const stopAuth = vi.fn(async () => {});
    const stop = createShutdownCoordinator({ stopServer, stopLaunched, stopAuth, timeoutMs: 100 });

    const first = stop();
    const second = stop();
    expect(second).toBe(first);
    release();
    await first;
    expect(stop()).toBe(first);
    expect(stopServer).toHaveBeenCalledOnce();
    expect(stopLaunched).toHaveBeenCalledOnce();
    expect(stopAuth).toHaveBeenCalledOnce();
  });

  it("returns typed failure after cleanup rejection", async () => {
    const stop = createShutdownCoordinator({
      stopServer: vi.fn(async () => {}),
      stopLaunched: vi.fn(async () => { throw new Error("raw failure"); }),
      stopAuth: vi.fn(async () => {}),
      timeoutMs: 100,
    });

    await expectShutdownCause(stop(), "shutdown_operation_failed");
  });

  it("bounds a hanging operation with one absolute deadline", async () => {
    const stop = createShutdownCoordinator({
      stopServer: vi.fn(() => new Promise<void>(() => {})),
      stopLaunched: vi.fn(async () => {}),
      stopAuth: vi.fn(async () => {}),
      timeoutMs: 15,
    });

    await expectShutdownCause(stop(), "shutdown_deadline");
  });

  it("succeeds with a server and no tracked children", async () => {
    const stop = createShutdownCoordinator({
      stopServer: vi.fn(async () => {}),
      stopLaunched: vi.fn(async () => {}),
      stopAuth: vi.fn(async () => {}),
    });

    await expect(stop()).resolves.toBeUndefined();
  });

  it("preserves an existing typed cleanup cause", async () => {
    const failure = new BridgeError("safe", {
      code: "SHUTDOWN_INCOMPLETE",
      status: 500,
      causeCode: "target_exit_timeout",
    });
    const stop = createShutdownCoordinator({
      stopServer: vi.fn(async () => {}),
      stopLaunched: vi.fn(async () => { throw failure; }),
      stopAuth: vi.fn(async () => {}),
    });

    await expectShutdownCause(stop(), "target_exit_timeout");
  });
});

describe("process signal lifecycle", () => {
  it("routes SIGINT and SIGTERM through the same app.stop coordinator", () => {
    const source = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");

    expect(source).toContain('process.on("SIGINT", () => void shutdown("SIGINT"))');
    expect(source).toContain('process.on("SIGTERM", () => void shutdown("SIGTERM"))');
    expect(source.match(/await app\.stop\(\)/g)).toHaveLength(1);
    expect(source).not.toContain("stopLaunchedProcesses");
    expect(source).not.toContain("stopActiveAuthChrome");
  });
});
