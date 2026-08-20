import { beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type DesktopStartModule = {
  BRIDGE_URL: string;
  HEALTH_URL: string;
  NODE_DOWNLOAD_URL: string;
  parseNodeMajor: (version: string | null | undefined) => number | null;
  isSupportedNodeVersion: (version: string) => boolean;
  runDesktopStart: (options?: Record<string, unknown>) => Promise<Record<string, boolean>>;
  waitForBridgeHealth: (options?: Record<string, unknown>) => Promise<void>;
};

let desktopStart: DesktopStartModule;

beforeAll(async () => {
  const moduleUrl = new URL("../../scripts/desktopStart.mjs", import.meta.url);
  desktopStart = await import(moduleUrl.href) as DesktopStartModule;
});

function successfulCommand() {
  return { code: 0, signal: null, error: null };
}

function startedBridge(exitResult: Record<string, unknown> | null = null) {
  return {
    exited: exitResult ? Promise.resolve(exitResult) : new Promise(() => {}),
    getExitResult: () => exitResult,
  };
}

function makeRuntime(overrides: Record<string, unknown> = {}) {
  return {
    nodeVersion: "20.17.0",
    npmVersion: vi.fn(async () => "10.8.2"),
    checkHealth: vi.fn(async () => false),
    pathExists: vi.fn(async () => true),
    needsBuild: vi.fn(async () => false),
    runNpm: vi.fn(async () => successfulCommand()),
    startBridge: vi.fn(() => startedBridge()),
    waitForBridgeHealth: vi.fn(async () => {}),
    openUrl: vi.fn(async () => true),
    log: vi.fn(),
    ...overrides,
  };
}

describe("desktop bootstrap", () => {
  it("rejects Node.js older than 20 and opens the official download page", async () => {
    const runtime = makeRuntime({ nodeVersion: "18.20.8" });

    await expect(desktopStart.runDesktopStart({ runtime, keepAlive: false }))
      .rejects.toMatchObject({ userMessage: "Для запуска нужен Node.js 20 или новее." });
    expect(runtime.openUrl).toHaveBeenCalledWith(desktopStart.NODE_DOWNLOAD_URL);
    expect(runtime.npmVersion).not.toHaveBeenCalled();
  });

  it("parses supported and unsupported Node.js versions", () => {
    expect(desktopStart.parseNodeMajor("v20.1.0")).toBe(20);
    expect(desktopStart.parseNodeMajor("19.9.0")).toBe(19);
    expect(desktopStart.parseNodeMajor("unknown")).toBeNull();
    expect(desktopStart.isSupportedNodeVersion("20.0.0")).toBe(true);
    expect(desktopStart.isSupportedNodeVersion("19.9.0")).toBe(false);
  });

  it("shows a clear error when npm is absent", async () => {
    const runtime = makeRuntime({ npmVersion: vi.fn(async () => null) });

    await expect(desktopStart.runDesktopStart({ runtime, keepAlive: false }))
      .rejects.toMatchObject({ userMessage: expect.stringContaining("Не найден npm") });
    expect(runtime.startBridge).not.toHaveBeenCalled();
  });

  it("installs dependencies and builds on the first launch", async () => {
    const runtime = makeRuntime({ pathExists: vi.fn(async () => false) });
    const result = await desktopStart.runDesktopStart({
      projectRoot: "D:\\DeepSeek Bridge",
      runtime,
      keepAlive: false,
    });

    expect(runtime.runNpm).toHaveBeenNthCalledWith(1, ["install"], "D:\\DeepSeek Bridge");
    expect(runtime.runNpm).toHaveBeenNthCalledWith(2, ["run", "build"], "D:\\DeepSeek Bridge");
    expect(runtime.needsBuild).not.toHaveBeenCalled();
    expect(result).toEqual({ alreadyRunning: false, installed: true, built: true });
  });

  it("does not reinstall when node_modules already exists", async () => {
    const runtime = makeRuntime();
    const result = await desktopStart.runDesktopStart({ runtime, keepAlive: false });

    expect(runtime.runNpm).not.toHaveBeenCalled();
    expect(result).toEqual({ alreadyRunning: false, installed: false, built: false });
  });

  it("runs build when installed sources require rebuilding", async () => {
    const runtime = makeRuntime({ needsBuild: vi.fn(async () => true) });
    const result = await desktopStart.runDesktopStart({ runtime, keepAlive: false });

    expect(runtime.runNpm).toHaveBeenCalledOnce();
    expect(runtime.runNpm).toHaveBeenCalledWith(["run", "build"], expect.any(String));
    expect(result.built).toBe(true);
  });

  it("opens Web UI without starting a second Bridge when health is already ready", async () => {
    const runtime = makeRuntime({ checkHealth: vi.fn(async () => true) });
    const result = await desktopStart.runDesktopStart({ runtime, keepAlive: false });

    expect(runtime.startBridge).not.toHaveBeenCalled();
    expect(runtime.pathExists).not.toHaveBeenCalled();
    expect(runtime.openUrl).toHaveBeenCalledWith(desktopStart.BRIDGE_URL);
    expect(result.alreadyRunning).toBe(true);
  });

  it("polls health until the started Bridge becomes ready", async () => {
    const check = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const wait = vi.fn(async () => {});

    await desktopStart.waitForBridgeHealth({
      check,
      wait,
      now: () => 0,
      timeoutMs: 1_000,
      intervalMs: 25,
    });

    expect(check).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("passes a Unicode project path only as cwd values", async () => {
    const projectRoot = "D:\\Проекты\\DeepSeek Bridge ёжик";
    const runtime = makeRuntime();

    await desktopStart.runDesktopStart({ projectRoot, runtime, keepAlive: false });

    expect(runtime.npmVersion).toHaveBeenCalledWith(projectRoot);
    expect(runtime.pathExists).toHaveBeenCalledWith(path.join(projectRoot, "node_modules"));
    expect(runtime.needsBuild).toHaveBeenCalledWith(projectRoot);
    expect(runtime.startBridge).toHaveBeenCalledWith(projectRoot);
  });

  it("reports npm install failure without starting Bridge", async () => {
    const runtime = makeRuntime({
      pathExists: vi.fn(async () => false),
      runNpm: vi.fn(async () => ({ code: 1, signal: null, error: null })),
    });

    await expect(desktopStart.runDesktopStart({ runtime, keepAlive: false }))
      .rejects.toMatchObject({ userMessage: "Не удалось установить необходимые компоненты." });
    expect(runtime.startBridge).not.toHaveBeenCalled();
  });

  it("reports build failure without starting Bridge", async () => {
    const runtime = makeRuntime({
      needsBuild: vi.fn(async () => true),
      runNpm: vi.fn(async () => ({ code: 2, signal: null, error: null })),
    });

    await expect(desktopStart.runDesktopStart({ runtime, keepAlive: false }))
      .rejects.toMatchObject({ userMessage: "Не удалось подготовить DeepSeek Web Bridge." });
    expect(runtime.startBridge).not.toHaveBeenCalled();
  });

  it("reports startup failure when npm start exits before health", async () => {
    const runtime = makeRuntime({
      startBridge: vi.fn(() => startedBridge({ code: 1, signal: null, error: null })),
      waitForBridgeHealth: desktopStart.waitForBridgeHealth,
    });

    await expect(desktopStart.runDesktopStart({ runtime, keepAlive: false }))
      .rejects.toMatchObject({ userMessage: "Не удалось запустить DeepSeek Web Bridge." });
    expect(runtime.openUrl).not.toHaveBeenCalled();
  });

  it("reports startup timeout when health never becomes ready", async () => {
    let clock = 0;
    await expect(desktopStart.waitForBridgeHealth({
      check: vi.fn(async () => false),
      getExitResult: () => null,
      wait: vi.fn(async (ms: number) => { clock += ms; }),
      now: () => clock,
      timeoutMs: 100,
      intervalMs: 25,
    })).rejects.toMatchObject({ userMessage: "Не удалось запустить DeepSeek Web Bridge." });
  });
});

describe("desktop launcher files", () => {
  const repositoryRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

  it("keeps the bootstrap dependency-free", async () => {
    const source = await fs.readFile(path.join(repositoryRoot, "scripts", "desktopStart.mjs"), "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every(specifier => specifier?.startsWith("node:"))).toBe(true);
    expect(source).toContain("shell: false");
    expect(source).not.toContain("shell: true");
  });

  it("keeps Windows launcher relative to its own location", async () => {
    const source = await fs.readFile(path.join(repositoryRoot, "START.bat"), "utf8");
    expect(source).toContain("%~dp0");
    expect(source).toContain("scripts\\desktopStart.mjs");
    expect(source).toContain("Для запуска нужен Node.js 20 или новее.");
    expect(source).not.toMatch(/[A-Z]:\\Проекты/i);
  });

  it("keeps macOS and Linux launchers relative and safely quoted", async () => {
    const command = await fs.readFile(path.join(repositoryRoot, "START.command"), "utf8");
    const shell = await fs.readFile(path.join(repositoryRoot, "START.sh"), "utf8");
    expect(command).toContain("$(dirname -- \"$0\")");
    expect(command).toContain("\"$SCRIPT_DIR/START.sh\"");
    expect(shell).toContain("$(dirname -- \"$0\")");
    expect(shell).toContain("node \"$SCRIPT_DIR/scripts/desktopStart.mjs\"");
    expect(shell).not.toContain("eval ");
  });

  it("keeps install and build logic in the shared Node bootstrap", async () => {
    const wrappers = await Promise.all([
      "START.bat",
      "START.command",
      "START.sh",
      "DeepSeek Web Bridge.desktop",
    ].map(name => fs.readFile(path.join(repositoryRoot, name), "utf8")));
    const bootstrap = await fs.readFile(path.join(repositoryRoot, "scripts", "desktopStart.mjs"), "utf8");
    expect(wrappers.join("\n")).not.toContain("npm install");
    expect(wrappers.join("\n")).not.toContain("npm run build");
    expect(bootstrap).toContain('["install"]');
    expect(bootstrap).toContain('["run", "build"]');
  });

  it("uses the desktop file location instead of an absolute Linux path", async () => {
    const source = await fs.readFile(path.join(repositoryRoot, "DeepSeek Web Bridge.desktop"), "utf8");
    expect(source).toContain("Terminal=true");
    expect(source).toContain("%k");
    expect(source).toContain("$1");
    expect(source).toContain("START.sh");
    expect(source).not.toContain("sh -c '");
    expect(source).not.toMatch(/Exec=.*\/(?:home|Users)\//);
  });
});
