import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { join, resolve, sep } from "node:path";
import { mkdtemp, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { performLogout, stopLaunchedProcesses, trackProcess, pickFolder } from "../../src/server/actions.js";

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
  it("kills tracked child processes and clears set", async () => {
    const child = spawn("node", ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
      detached: true,
    });
    trackProcess(child);
    await stopLaunchedProcesses();
    await new Promise(r => setTimeout(r, 1000));
    let alive = true;
    try { process.kill(child.pid!, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  });

  it("does not kill untracked processes", async () => {
    const victim = spawn("node", ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
      detached: true,
    });
    await stopLaunchedProcesses();
    let alive = true;
    try { process.kill(victim.pid!, 0); } catch { alive = false; }
    expect(alive).toBe(true);
    try { victim.kill("SIGTERM"); } catch {}
  });
});

describe("pickFolder", () => {
  it("returns supported=false on non-Windows", async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const result = await pickFolder();
      expect(result.supported).toBe(false);
      expect(result.path).toBeNull();
      expect(result.cancelled).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });

  it("returns supported=false on darwin", async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      const result = await pickFolder();
      expect(result.supported).toBe(false);
      expect(result.path).toBeNull();
      expect(result.cancelled).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });
});
