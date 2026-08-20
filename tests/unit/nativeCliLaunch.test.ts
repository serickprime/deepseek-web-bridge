import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, spawn: vi.fn() };
});

import * as childProcess from "node:child_process";
import { launchClaudeCode, launchOpenCode } from "../../src/server/actions.js";
import {
  buildLinuxTerminalCommand,
  quotePosixShellArg,
  resolveUnixWorkDir,
  stopNativeTerminalLaunches,
} from "../../src/server/terminalLaunch.js";
import { findLinuxTerminalEmulator, getSystemCapabilities } from "../../src/server/system.js";

function fakeChild(pid = 41000) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = pid;
  child.exitCode = null;
  child.kill = vi.fn(() => {
    child.exitCode = 0;
    return true;
  });
  child.unref = vi.fn();
  return child;
}

const tempDirs: string[] = [];

async function unicodeWorkDir(name = "Проекты Test folder ёжик"): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bridge-native-launch-"));
  tempDirs.push(root);
  const cwd = path.join(root, name);
  await fs.promises.mkdir(cwd);
  return cwd;
}

beforeEach(() => {
  vi.mocked(childProcess.spawn).mockReset();
});

afterEach(async () => {
  await stopNativeTerminalLaunches();
  await Promise.all(tempDirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })));
  vi.clearAllMocks();
});

describe("macOS native Terminal.app launch", () => {
  it("launches Claude Code with its model in a new Terminal.app session", async () => {
    const cwd = await unicodeWorkDir();
    const child = fakeChild();
    vi.mocked(childProcess.spawn).mockReturnValue(child as never);

    const launched = await launchClaudeCode(cwd, "deepseek-v4-pro", vi.fn(), {
      platform: "darwin",
      commandAvailable: async () => true,
      pathAvailable: () => true,
    });

    expect(launched).toBe(child);
    const [command, args, options] = vi.mocked(childProcess.spawn).mock.calls[0]!;
    expect(command).toBe("osascript");
    expect(args).toEqual(["-e", expect.stringContaining('tell application "Terminal"'), expect.any(String)]);
    expect(args![2]).toContain(quotePosixShellArg("claude"));
    expect(args![2]).toContain(quotePosixShellArg("--model"));
    expect(args![2]).toContain(quotePosixShellArg("deepseek-v4-pro"));
    expect(options).toMatchObject({ cwd, shell: false, detached: true });
  });

  it("launches OpenCode and propagates all Bridge environment variables", async () => {
    const cwd = await unicodeWorkDir();
    const child = fakeChild();
    vi.mocked(childProcess.spawn).mockReturnValue(child as never);

    await launchOpenCode(cwd, "deepseek-v4-flash", vi.fn(), {
      platform: "darwin",
      commandAvailable: async () => true,
      pathAvailable: () => true,
    });

    const [, args, options] = vi.mocked(childProcess.spawn).mock.calls[0]!;
    const invocation = String(args![2]);
    expect(invocation).toContain(quotePosixShellArg(cwd));
    expect(invocation).toContain(quotePosixShellArg("opencode"));
    expect(invocation).toContain(quotePosixShellArg("--model"));
    expect(invocation).toContain(quotePosixShellArg("deepseek-bridge/deepseek-v4-flash"));
    expect(invocation).toContain("DeepSeek Bridge");
    expect(invocation).toContain(quotePosixShellArg("http://127.0.0.1:9655"));
    expect(invocation).toContain(quotePosixShellArg("local-key"));
    expect(invocation).toContain(quotePosixShellArg("http://127.0.0.1:9655/v1"));
    expect(options).toMatchObject({
      env: expect.objectContaining({
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9655",
        ANTHROPIC_AUTH_TOKEN: "local-key",
        OPENAI_API_BASE: "http://127.0.0.1:9655/v1",
        OPENAI_API_KEY: "local-key",
        OPENCODE_CONFIG_CONTENT: expect.stringContaining('"deepseek-bridge"'),
      }),
    });
  });

  it("keeps Unicode and shell metacharacters out of the static AppleScript source", async () => {
    const cwd = await unicodeWorkDir("Проекты ёжик ' ; touch SHOULD_NOT_RUN");
    const child = fakeChild();
    vi.mocked(childProcess.spawn).mockReturnValue(child as never);

    await launchClaudeCode(cwd, "deepseek-chat", vi.fn(), {
      platform: "darwin",
      commandAvailable: async () => true,
      pathAvailable: () => true,
    });

    const [, args] = vi.mocked(childProcess.spawn).mock.calls[0]!;
    expect(String(args![1])).not.toContain(cwd);
    expect(String(args![2])).toContain(quotePosixShellArg(cwd));
    expect(String(args![2])).not.toContain(`'${cwd}'`);
  });

  it("expands a leading ~/ without changing the Unicode suffix", () => {
    expect(resolveUnixWorkDir("~/Проекты/Test folder/ёжик", "/Users/tester"))
      .toBe("/Users/tester/Проекты/Test folder/ёжик");
  });
});

describe("Linux native terminal launch", () => {
  it.each([
    ["x-terminal-emulator", ["-T", "Bridge", "-e"]],
    ["gnome-terminal", ["--wait", "--working-directory=/tmp/Проекты ёжик", "--"]],
    ["konsole", ["--separate", "--workdir", "/tmp/Проекты ёжик", "-e"]],
    ["xfce4-terminal", ["--disable-server", "--working-directory=/tmp/Проекты ёжик", "--execute"]],
    ["kitty", ["--single-instance=no", "--directory", "/tmp/Проекты ёжик", "--title", "Bridge"]],
    ["xterm", ["-T", "Bridge", "-e"]],
  ] as const)("uses the documented argv contract for %s", (terminal, prefix) => {
    const command = buildLinuxTerminalCommand(terminal, ["/tmp/run.sh", "claude", "--model", "deepseek-chat"], "/tmp/Проекты ёжик", "Bridge");
    expect(command.command).toBe(terminal);
    expect(command.args.slice(0, prefix.length)).toEqual(prefix);
    expect(command.args.slice(prefix.length)).toEqual(["/tmp/run.sh", "claude", "--model", "deepseek-chat"]);
  });

  it("preserves Unicode cwd and Bridge env through the root x-terminal-emulator launch", async () => {
    const cwd = await unicodeWorkDir();
    const child = fakeChild();
    vi.mocked(childProcess.spawn).mockReturnValue(child as never);
    const available = vi.fn(async (command: string) => command === "claude" || command === "x-terminal-emulator");

    await launchClaudeCode(cwd, "deepseek-chat", vi.fn(), {
      platform: "linux",
      commandAvailable: available,
    });

    const [command, args, options] = vi.mocked(childProcess.spawn).mock.calls[0]!;
    expect(command).toBe("x-terminal-emulator");
    expect(args).toContain(cwd);
    expect(args).toContain("claude");
    expect(options).toMatchObject({
      cwd,
      shell: false,
      env: expect.objectContaining({
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9655",
        ANTHROPIC_AUTH_TOKEN: "local-key",
        OPENAI_API_BASE: "http://127.0.0.1:9655/v1",
        OPENAI_API_KEY: "local-key",
      }),
    });
  });

  it("falls back in priority order to the first available emulator", async () => {
    const available = vi.fn(async (command: string) => command === "kitty");
    await expect(findLinuxTerminalEmulator(available)).resolves.toBe("kitty");
    expect(available.mock.calls.map(call => call[0])).toEqual([
      "x-terminal-emulator",
      "gnome-terminal",
      "konsole",
      "xfce4-terminal",
      "kitty",
    ]);
  });

  it("reports launch capabilities false when no emulator is installed", async () => {
    await expect(getSystemCapabilities("linux", async () => false)).resolves.toEqual({
      platform: "linux",
      folderPicker: false,
      claudeCodeLaunch: false,
      openCodeLaunch: false,
    });
  });

  it("returns a clear error when the requested CLI binary is missing", async () => {
    const cwd = await unicodeWorkDir();
    const send = vi.fn();

    await expect(launchOpenCode(cwd, "deepseek-chat", send, {
      platform: "linux",
      commandAvailable: async () => false,
    })).resolves.toBeNull();

    expect(send).toHaveBeenCalledWith({
      type: "error",
      message: "opencode executable was not found in the Bridge PATH. Install it or start it manually.",
    });
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it("SHUTDOWN tracking stops only the terminal child created by Bridge", async () => {
    const cwd = await unicodeWorkDir();
    const tracked = fakeChild();
    const unrelated = fakeChild(42000);
    vi.mocked(childProcess.spawn).mockReturnValue(tracked as never);

    await launchClaudeCode(cwd, "deepseek-chat", vi.fn(), {
      platform: "linux",
      commandAvailable: async command => command === "claude" || command === "konsole",
    });
    await stopNativeTerminalLaunches();

    expect(tracked.kill).toHaveBeenCalledWith("SIGTERM");
    expect(unrelated.kill).not.toHaveBeenCalled();
  });
});
