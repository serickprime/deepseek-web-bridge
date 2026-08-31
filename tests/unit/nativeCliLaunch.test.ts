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
  createUnixCliRunner,
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
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => {
    child.exitCode = 0;
    return true;
  });
  child.unref = vi.fn();
  return child;
}

function finishChild(child: ReturnType<typeof fakeChild>, code = 0): void {
  child.exitCode = code;
  child.emit("exit", code, null);
  child.emit("close", code, null);
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

function nativePidFiles(args: readonly unknown[] | undefined): string[] {
  return (args ?? []).flatMap(arg => {
    if (typeof arg !== "string") return [];
    if (arg.endsWith("cli.pid")) return [arg];
    return [...arg.matchAll(/'([^']+cli\.pid)'/g)].map(match => match[1]!);
  });
}

async function seedMissingNativePidFiles(): Promise<void> {
  let pid = 49000;
  for (const [, args] of vi.mocked(childProcess.spawn).mock.calls) {
    for (const pidFile of nativePidFiles(args)) {
      if (fs.existsSync(pidFile) || !fs.existsSync(path.dirname(pidFile))) continue;
      await fs.promises.writeFile(pidFile, String(pid++), "utf8");
    }
  }
}

describe("POSIX CLI runner environment", () => {
  it("exports gateway discovery for Claude without adding it to OpenCode", async () => {
    const cwd = await unicodeWorkDir();
    const baseEnv = {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9655",
      ANTHROPIC_AUTH_TOKEN: "local-key",
      OPENAI_API_BASE: "http://127.0.0.1:9655/v1",
      OPENAI_API_KEY: "local-key",
    };
    const claudeRunner = createUnixCliRunner(cwd, {
      ...baseEnv,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    }, "claude", ["--model", "deepseek-v4-flash"]);
    const openCodeRunner = createUnixCliRunner(cwd, {
      ...baseEnv,
      OPENCODE_CONFIG_CONTENT: "bridge-config",
    }, "opencode", ["--model", "deepseek-bridge/deepseek-v4-flash"]);
    tempDirs.push(claudeRunner.tempDir, openCodeRunner.tempDir);

    expect(claudeRunner.runnerArgs.slice(7, 10)).toEqual(["1", "", "claude"]);
    expect(openCodeRunner.runnerArgs.slice(7, 10)).toEqual(["", "bridge-config", "opencode"]);
    const runnerSource = fs.readFileSync(claudeRunner.runnerArgs[0]!, "utf8");
    expect(runnerSource).toContain('export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY="$claude_gateway_model_discovery"');
  });
});

afterEach(async () => {
  await seedMissingNativePidFiles();
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
    expect(options?.env).toEqual(expect.objectContaining({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9655",
      ANTHROPIC_AUTH_TOKEN: "local-key",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    }));
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
    expect(options?.env).not.toHaveProperty("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY");
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
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
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
    const cliPid = 42001;
    vi.mocked(childProcess.spawn).mockReturnValue(tracked as never);

    await launchClaudeCode(cwd, "deepseek-chat", vi.fn(), {
      platform: "linux",
      commandAvailable: async command => command === "claude" || command === "konsole",
    });
    const args = vi.mocked(childProcess.spawn).mock.calls.at(-1)![1]!;
    const pidFile = args.find(arg => typeof arg === "string" && arg.endsWith("cli.pid"));
    await fs.promises.writeFile(pidFile as string, String(cliPid), "utf8");
    const alive = new Set([cliPid, tracked.pid]);
    await stopNativeTerminalLaunches({
      isProcessAlive: pid => alive.has(pid),
      signalProcess: vi.fn(pid => { alive.delete(pid); }),
    });

    expect(tracked.kill).toHaveBeenCalledWith("SIGTERM");
    expect(unrelated.kill).not.toHaveBeenCalled();
  });
});

describe("native terminal shutdown lifecycle", () => {
  async function launchMacRecord() {
    const cwd = await unicodeWorkDir();
    const launcher = fakeChild(43001);
    vi.mocked(childProcess.spawn).mockReturnValueOnce(launcher as never);
    await launchClaudeCode(cwd, "deepseek-chat", vi.fn(), {
      platform: "darwin",
      commandAvailable: async () => true,
      pathAvailable: () => true,
    });
    const args = vi.mocked(childProcess.spawn).mock.calls.at(-1)![1]!;
    const [pidFile] = nativePidFiles(args);
    expect(pidFile).toBeTypeOf("string");
    await fs.promises.writeFile(pidFile!, "43004", "utf8");
    launcher.stdout.write("731|/dev/ttys009\n");
    launcher.stdout.end();
    finishChild(launcher);
    return launcher;
  }

  function closeHelper(control: string, code = 0) {
    const helper = fakeChild(43002);
    process.nextTick(() => {
      helper.stdout.write(control);
      helper.stdout.end();
      finishChild(helper, code);
    });
    return helper;
  }

  it("closes only the exact macOS window id and tty and accepts closed", async () => {
    await launchMacRecord();
    const spawnProcess = vi.fn(() => closeHelper("closed\n") as never);

    await stopNativeTerminalLaunches({ isProcessAlive: () => false, spawnProcess: spawnProcess as never });

    expect(spawnProcess).toHaveBeenCalledWith(
      "osascript",
      ["-e", expect.stringContaining("targetId"), "731", "/dev/ttys009"],
      { stdio: ["ignore", "pipe", "ignore"], shell: false },
    );
  });

  it("treats macOS not-found as a safe narrow no-op", async () => {
    await launchMacRecord();
    const warning = vi.fn();

    await stopNativeTerminalLaunches({
      isProcessAlive: () => false,
      spawnProcess: vi.fn(() => closeHelper("not-found\n") as never) as never,
      onWarning: warning,
    });

    expect(warning).not.toHaveBeenCalled();
  });

  it("reports macOS helper non-zero as a non-destructive warning", async () => {
    await launchMacRecord();
    const warning = vi.fn();

    await stopNativeTerminalLaunches({
      isProcessAlive: () => false,
      spawnProcess: vi.fn(() => closeHelper("", 1) as never) as never,
      onWarning: warning,
    });

    expect(warning).toHaveBeenCalledWith("mac_window_close_failed");
  });

  it("reports macOS helper spawn error as a non-destructive warning", async () => {
    await launchMacRecord();
    const warning = vi.fn();

    await stopNativeTerminalLaunches({
      isProcessAlive: () => false,
      spawnProcess: vi.fn(() => { throw new Error("synthetic"); }) as never,
      onWarning: warning,
    });

    expect(warning).toHaveBeenCalledWith("mac_window_close_failed");
  });

  it("bounds a hanging macOS helper and retains the record for retry", async () => {
    await launchMacRecord();
    const hanging = fakeChild(43003);

    await expect(stopNativeTerminalLaunches({
      isProcessAlive: () => false,
      spawnProcess: vi.fn(() => hanging as never) as never,
      macWindowTimeoutMs: 10,
    })).rejects.toMatchObject({ code: "SHUTDOWN_INCOMPLETE", causeCode: "mac_window_close_failed" });
    expect(hanging.kill).toHaveBeenCalledWith("SIGKILL");

    await stopNativeTerminalLaunches({
      isProcessAlive: () => false,
      spawnProcess: vi.fn(() => closeHelper("not-found\n") as never) as never,
    });
  });

  async function launchLinuxRecord(cliPid: number) {
    const cwd = await unicodeWorkDir();
    const launcher = fakeChild(44001);
    vi.mocked(childProcess.spawn).mockReturnValueOnce(launcher as never);
    await launchClaudeCode(cwd, "deepseek-chat", vi.fn(), {
      platform: "linux",
      commandAvailable: async command => command === "claude" || command === "konsole",
    });
    const args = vi.mocked(childProcess.spawn).mock.calls.at(-1)![1]!;
    const pidFile = args.find(arg => typeof arg === "string" && arg.endsWith("cli.pid"));
    expect(pidFile).toBeTypeOf("string");
    await fs.promises.writeFile(pidFile!, String(cliPid), "utf8");
    return launcher;
  }

  async function launchLinuxRecordBeforePid() {
    const cwd = await unicodeWorkDir();
    const launcher = fakeChild(44101);
    vi.mocked(childProcess.spawn).mockReturnValueOnce(launcher as never);
    await launchClaudeCode(cwd, "deepseek-chat", vi.fn(), {
      platform: "linux",
      commandAvailable: async command => command === "claude" || command === "konsole",
    });
    const args = vi.mocked(childProcess.spawn).mock.calls.at(-1)![1]!;
    const pidFile = args.find(arg => typeof arg === "string" && arg.endsWith("cli.pid"));
    expect(pidFile).toBeTypeOf("string");
    return { launcher, pidFile: pidFile as string, tempDir: path.dirname(pidFile as string) };
  }

  it.each(["44104garbage", "44x"])(
    "rejects malformed CLI PID content %s without signalling it and retains ownership for retry",
    async malformedPid => {
      const { launcher, pidFile, tempDir } = await launchLinuxRecordBeforePid();
      const parsedPrefix = Number.parseInt(malformedPid, 10);
      const alive = new Set([launcher.pid, parsedPrefix]);
      const signalProcess = vi.fn((pid: number) => { alive.delete(pid); });
      await fs.promises.writeFile(pidFile, malformedPid, "utf8");

      await expect(stopNativeTerminalLaunches({
        isProcessAlive: pid => alive.has(pid),
        signalProcess,
        timeoutMs: 15,
      })).rejects.toMatchObject({ code: "SHUTDOWN_INCOMPLETE", causeCode: "native_pid_capture_timeout" });

      expect(signalProcess).not.toHaveBeenCalled();
      expect(launcher.kill).not.toHaveBeenCalled();
      expect(fs.existsSync(tempDir)).toBe(true);

      await fs.promises.writeFile(pidFile, "44105", "utf8");
      await stopNativeTerminalLaunches({ isProcessAlive: () => false });
      await vi.waitFor(() => expect(fs.existsSync(tempDir)).toBe(false));
    },
  );

  it("accepts a complete decimal CLI PID surrounded by whitespace", async () => {
    const cliPid = 44106;
    const { launcher, pidFile } = await launchLinuxRecordBeforePid();
    const alive = new Set([cliPid, launcher.pid]);
    const signalProcess = vi.fn((pid: number) => { alive.delete(pid); });
    await fs.promises.writeFile(pidFile, ` \r\n${cliPid}\t\n`, "utf8");

    await stopNativeTerminalLaunches({
      isProcessAlive: pid => alive.has(pid),
      signalProcess,
      timeoutMs: 100,
    });

    expect(signalProcess).toHaveBeenCalledWith(cliPid, "SIGTERM");
    expect(launcher.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("cleans ownership when the native launcher fails before spawn", async () => {
    const { launcher, tempDir } = await launchLinuxRecordBeforePid();

    launcher.emit("error", new Error("synthetic initial spawn failure"));

    await vi.waitFor(() => expect(fs.existsSync(tempDir)).toBe(false));
    await expect(stopNativeTerminalLaunches()).resolves.toBeUndefined();
  });

  it("retains post-spawn launcher ownership after a kill error and allows retry", async () => {
    const cliPid = process.pid;
    const { launcher, pidFile, tempDir } = await launchLinuxRecordBeforePid();
    launcher.emit("spawn");
    await fs.promises.writeFile(pidFile, String(cliPid), "utf8");
    const alive = new Set([cliPid, launcher.pid]);
    const signalProcess = vi.fn((pid: number) => { alive.delete(pid); });
    launcher.kill.mockImplementationOnce(() => {
      launcher.emit("error", new Error("synthetic post-spawn kill failure"));
      return false;
    });

    await expect(stopNativeTerminalLaunches({
      isProcessAlive: pid => alive.has(pid),
      signalProcess,
      timeoutMs: 50,
    })).rejects.toMatchObject({ code: "SHUTDOWN_INCOMPLETE", causeCode: "signal_send_failed" });

    expect(fs.existsSync(tempDir)).toBe(true);

    await stopNativeTerminalLaunches({ isProcessAlive: () => false });
    await vi.waitFor(() => expect(fs.existsSync(tempDir)).toBe(false));
  });

  it("handles repeated post-spawn kill errors and retains ownership until a later successful retry", async () => {
    const cliPid = process.pid;
    const { launcher, pidFile, tempDir } = await launchLinuxRecordBeforePid();
    launcher.emit("spawn");
    await fs.promises.writeFile(pidFile, String(cliPid), "utf8");
    const alive = new Set([cliPid, launcher.pid]);
    const signalProcess = vi.fn((pid: number) => { alive.delete(pid); });
    let killAttempts = 0;
    launcher.kill.mockImplementation(() => {
      killAttempts++;
      if (killAttempts <= 2) {
        launcher.emit("error", new Error(`synthetic post-spawn kill failure ${killAttempts}`));
        return false;
      }
      alive.delete(launcher.pid);
      finishChild(launcher);
      return true;
    });

    for (let attempt = 1; attempt <= 2; attempt++) {
      await expect(stopNativeTerminalLaunches({
        isProcessAlive: pid => alive.has(pid),
        signalProcess,
        timeoutMs: 50,
      })).rejects.toMatchObject({ code: "SHUTDOWN_INCOMPLETE", causeCode: "signal_send_failed" });

      expect(killAttempts).toBe(attempt);
      expect(launcher.listenerCount("error")).toBe(1);
      expect(fs.existsSync(tempDir)).toBe(true);
    }

    await stopNativeTerminalLaunches({
      isProcessAlive: pid => alive.has(pid),
      signalProcess,
      timeoutMs: 50,
    });

    expect(killAttempts).toBe(3);
    await vi.waitFor(() => expect(fs.existsSync(tempDir)).toBe(false));
  });

  it("waits for a CLI PID written after shutdown starts and confirms its exit", async () => {
    const cliPid = 44102;
    const { launcher, pidFile, tempDir } = await launchLinuxRecordBeforePid();
    const alive = new Set([cliPid, launcher.pid]);
    const signalProcess = vi.fn((pid: number) => { alive.delete(pid); });

    const stopping = stopNativeTerminalLaunches({
      isProcessAlive: pid => alive.has(pid),
      signalProcess,
      timeoutMs: 200,
    });
    expect(fs.existsSync(pidFile)).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 10));
    await fs.promises.writeFile(pidFile, String(cliPid), "utf8");

    await stopping;

    expect(signalProcess).toHaveBeenCalledWith(cliPid, "SIGTERM");
    await vi.waitFor(() => expect(fs.existsSync(tempDir)).toBe(false));
  });

  it("fails boundedly and retains ownership when the CLI PID never appears", async () => {
    const { launcher, pidFile, tempDir } = await launchLinuxRecordBeforePid();

    await expect(stopNativeTerminalLaunches({
      isProcessAlive: pid => pid === launcher.pid,
      timeoutMs: 15,
    })).rejects.toMatchObject({ code: "SHUTDOWN_INCOMPLETE", causeCode: "native_pid_capture_timeout" });

    expect(launcher.kill).not.toHaveBeenCalled();
    expect(fs.existsSync(tempDir)).toBe(true);

    await fs.promises.writeFile(pidFile, "44103", "utf8");
    await stopNativeTerminalLaunches({ isProcessAlive: () => false });
    await vi.waitFor(() => expect(fs.existsSync(tempDir)).toBe(false));
  });

  it("does not treat launcher exit during pending PID capture as proof that no CLI started", async () => {
    const { launcher, pidFile, tempDir } = await launchLinuxRecordBeforePid();
    finishChild(launcher);

    await expect(stopNativeTerminalLaunches({
      isProcessAlive: () => false,
      timeoutMs: 15,
    })).rejects.toMatchObject({ code: "SHUTDOWN_INCOMPLETE", causeCode: "native_pid_capture_timeout" });

    expect(fs.existsSync(tempDir)).toBe(true);
    await fs.promises.writeFile(pidFile, "44104", "utf8");
    await stopNativeTerminalLaunches({ isProcessAlive: () => false });
  });

  it("confirms Linux runner PID exit after SIGTERM", async () => {
    const cliPid = 44002;
    const launcher = await launchLinuxRecord(cliPid);
    const alive = new Set([cliPid, launcher.pid]);

    await stopNativeTerminalLaunches({
      isProcessAlive: pid => alive.has(pid),
      signalProcess: vi.fn(pid => { alive.delete(pid); }),
      timeoutMs: 100,
    });

    expect(launcher.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("keeps a Linux record when SIGTERM cannot be sent", async () => {
    const cliPid = 44003;
    await launchLinuxRecord(cliPid);

    await expect(stopNativeTerminalLaunches({
      isProcessAlive: pid => pid === cliPid,
      signalProcess: vi.fn(() => { throw new Error("synthetic"); }),
      timeoutMs: 15,
    })).rejects.toMatchObject({ code: "SHUTDOWN_INCOMPLETE", causeCode: "signal_send_failed" });

    await stopNativeTerminalLaunches({ isProcessAlive: () => false });
  });

  it("bounds Linux runner exit confirmation", async () => {
    const cliPid = 44004;
    await launchLinuxRecord(cliPid);

    await expect(stopNativeTerminalLaunches({
      isProcessAlive: pid => pid === cliPid,
      signalProcess: vi.fn(),
      timeoutMs: 10,
    })).rejects.toMatchObject({ code: "SHUTDOWN_INCOMPLETE", causeCode: "target_exit_timeout" });

    await stopNativeTerminalLaunches({ isProcessAlive: () => false });
  });
});
