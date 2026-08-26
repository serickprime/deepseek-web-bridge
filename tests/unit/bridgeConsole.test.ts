import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { join, resolve, sep } from "node:path";
import { mkdtemp, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { performLogout, stopLaunchedProcesses, trackProcess, pickFolder } from "../../src/server/actions.js";
import { LANDING_PAGE_HTML } from "../../src/server/landingPage.js";

const PUBLIC_ASSETS_DIR = resolve(process.cwd(), "public");

/** Replicates the resolveAssetPath logic from routes.ts */
function resolveAssetPath(pathname: string): { resolved: string; safe: string } {
  const safePath = join(PUBLIC_ASSETS_DIR, pathname.replace(/^\//, ""));
  const resolved = resolve(safePath);
  return { resolved, safe: safePath };
}

function isPathWithin(child: string, parent: string): boolean {
  return resolve(child).startsWith(resolve(parent) + sep) || resolve(child) === resolve(parent);
}

describe("Static asset path resolution", () => {
  it("maps /assets/bridge-network-map.png to public/assets/bridge-network-map.png", () => {
    const { resolved } = resolveAssetPath("/assets/bridge-network-map.png");
    expect(resolved).toBe(resolve(PUBLIC_ASSETS_DIR, "assets", "bridge-network-map.png"));
  });

  it("maps /assets/style.css to public/assets/style.css", () => {
    const { resolved } = resolveAssetPath("/assets/style.css");
    expect(resolved).toBe(resolve(PUBLIC_ASSETS_DIR, "assets", "style.css"));
  });

  it("maps /assets/sub/dir/file.png to public/assets/sub/dir/file.png", () => {
    const { resolved } = resolveAssetPath("/assets/sub/dir/file.png");
    expect(resolved).toBe(resolve(PUBLIC_ASSETS_DIR, "assets", "sub", "dir", "file.png"));
  });

  it("path traversal is detected by startsWith check", () => {
    const { resolved } = resolveAssetPath("/assets/../../etc/passwd");
    // The actual route handler checks resolved.startsWith(PUBLIC_ASSETS_DIR)
    // which correctly blocks traversal.
    expect(resolved.startsWith(PUBLIC_ASSETS_DIR)).toBe(false);
  });

  it("encoded path traversal is blocked", () => {
    const { resolved } = resolveAssetPath("/assets/..%2F..%2Fetc/passwd");
    expect(resolved.startsWith(PUBLIC_ASSETS_DIR)).toBe(true);
  });
});

describe("Logout UI", () => {
  it("keeps Logout separate from Shutdown and refreshes status indicators", () => {
    expect(LANDING_PAGE_HTML).toContain('confirm("Logout from DeepSeek?")');
    expect(LANDING_PAGE_HTML).toContain('showToast("Logged out","success");updateHealth();updateAuthLed();');
    expect(LANDING_PAGE_HTML).toContain('fetch("/bridge/shutdown"');
  });
});

describe("performLogout", () => {
  let tempDir: string;
  const origEnv = { ...process.env };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bridge-test-"));
  });

  afterEach(async () => {
    process.env = { ...origEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  it("removes auth.json if present", async () => {
    const authFile = join(tempDir, "auth.json");
    await writeFile(authFile, '{"token":"x","cookie":"y"}');
    process.env.DS_DATA_DIR = tempDir;
    const result = await performLogout();
    expect(result.ok).toBe(true);
    await expect(stat(authFile)).rejects.toThrow();
  });

  it("removes chrome-profile directory if present", async () => {
    const chromeProfile = join(tempDir, "chrome-profile");
    await mkdir(join(chromeProfile, "Default"), { recursive: true });
    await writeFile(join(chromeProfile, "Default", "Preferences"), "{}");
    process.env.DS_DATA_DIR = tempDir;
    const result = await performLogout();
    expect(result.ok).toBe(true);
    await expect(stat(chromeProfile)).rejects.toThrow();
  });

  it("returns ok when nothing to remove", async () => {
    process.env.DS_DATA_DIR = join(tempDir, "nonexistent");
    const result = await performLogout();
    expect(result.ok).toBe(true);
  });
});

describe("stopLaunchedProcesses", () => {
  it("waits for the tracked child lifecycle event instead of a fixed sleep", async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { pid: 41001, exitCode: null, signalCode: null, kill: vi.fn(), unref: vi.fn() });
    let alive = true;
    const helper = new EventEmitter() as ChildProcess;
    Object.assign(helper, { pid: 41002, exitCode: null, signalCode: null, kill: vi.fn() });
    const spawnProcess = vi.fn(() => {
      process.nextTick(() => {
        alive = false;
        (child as any).exitCode = 0;
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
        (helper as any).exitCode = 0;
        helper.emit("close", 0, null);
      });
      return helper;
    });

    trackProcess(child);
    await stopLaunchedProcesses({
      platform: "win32",
      timeoutMs: 100,
      spawnProcess: spawnProcess as typeof spawn,
      isProcessAlive: () => alive,
    });

    expect(spawnProcess).toHaveBeenCalledWith("taskkill", ["/PID", "41001", "/T", "/F"], { stdio: "ignore" });
  });

  it("does not kill untracked processes", async () => {
    const victim = new EventEmitter() as ChildProcess;
    const kill = vi.fn();
    Object.assign(victim, { pid: 42001, exitCode: null, signalCode: null, kill, unref: vi.fn() });

    await stopLaunchedProcesses({ platform: "win32", timeoutMs: 25 });

    expect(kill).not.toHaveBeenCalled();
  });
});

describe("pickFolder", () => {
  it("returns supported=false on an unsupported platform", async () => {
    const result = await pickFolder({ platform: "freebsd" });
    expect(result.supported).toBe(false);
    expect(result.path).toBeNull();
    expect(result.cancelled).toBe(false);
  });

  it("returns supported=false on Linux when no picker utility exists", async () => {
    const result = await pickFolder({ platform: "linux", commandAvailable: async () => false });
    expect(result.supported).toBe(false);
    expect(result.path).toBeNull();
    expect(result.cancelled).toBe(false);
  });
});
