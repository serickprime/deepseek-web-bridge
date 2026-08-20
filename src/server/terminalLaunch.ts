import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  findLinuxTerminalEmulator,
  isCommandAvailable,
  isMacTerminalLaunchAvailable,
  type CommandAvailability,
  type LinuxTerminalEmulator,
  type PathAvailability,
} from "./system.js";

export type CliTool = "claude" | "opencode";

export interface LaunchEvent {
  type: "progress" | "result" | "error" | "log";
  step?: string;
  ok?: boolean;
  message?: string;
  data?: unknown;
}

export interface NativeLaunchOptions {
  platform?: NodeJS.Platform;
  commandAvailable?: CommandAvailability;
  pathAvailable?: PathAvailability;
}

export interface TerminalCommand {
  command: string;
  args: string[];
}

export interface UnixCliRunner {
  tempDir: string;
  pidFile: string;
  runnerArgs: string[];
}

interface NativeLaunchRecord {
  child: ChildProcess;
  platform: "darwin" | "linux";
  tempDir: string;
  pidFile: string;
  cliPid?: number;
  macWindowId?: number;
  macTty?: string;
  monitor?: NodeJS.Timeout;
}

const MACOS_LAUNCH_SCRIPT = `on run argv
  set launchCommand to item 1 of argv
  tell application "Terminal"
    activate
    set launchedTab to do script launchCommand
    set terminalTty to ""
    repeat 40 times
      set terminalTty to tty of launchedTab
      if terminalTty is not "" then exit repeat
      delay 0.05
    end repeat
    return ((id of window of launchedTab) as text) & "|" & terminalTty
  end tell
end run`;

const MACOS_CLOSE_SCRIPT = `on run argv
  set targetId to (item 1 of argv) as integer
  set targetTty to item 2 of argv
  tell application "Terminal"
    repeat with candidateWindow in windows
      if (id of candidateWindow) is targetId then
        if (count of tabs of candidateWindow) is 1 then
          set candidateTab to selected tab of candidateWindow
          if (tty of candidateTab) is targetTty then
            close candidateWindow
            return "closed"
          end if
        end if
      end if
    end repeat
  end tell
  return "not-found"
end run`;

const UNIX_RUNNER_SOURCE = `#!/bin/sh
pid_file=$1
work_dir=$2
anthropic_base_url=$3
anthropic_auth_token=$4
openai_api_base=$5
openai_api_key=$6
opencode_config_content=$7
shift 7
umask 077
printf '%s\n' "$$" > "$pid_file"
if ! cd "$work_dir"; then
  printf 'DeepSeek Bridge: working directory not found: %s\n' "$work_dir" >&2
  exit 72
fi
export ANTHROPIC_BASE_URL="$anthropic_base_url"
export ANTHROPIC_AUTH_TOKEN="$anthropic_auth_token"
export OPENAI_API_BASE="$openai_api_base"
export OPENAI_API_KEY="$openai_api_key"
if [ -n "$opencode_config_content" ]; then
  export OPENCODE_CONFIG_CONTENT="$opencode_config_content"
fi
if [ "$#" -eq 0 ]; then
  printf 'DeepSeek Bridge: no CLI command supplied\n' >&2
  exit 64
fi
exec "$@"
`;

const nativeLaunches = new Set<NativeLaunchRecord>();

export function quotePosixShellArg(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function resolveUnixWorkDir(value: string, homeDir: string = os.homedir()): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.posix.join(homeDir, value.slice(2));
  return value;
}

export function buildMacTerminalCommand(runnerArgs: readonly string[]): TerminalCommand {
  const launchCommand = runnerArgs.map(quotePosixShellArg).join(" ");
  return {
    command: "osascript",
    args: ["-e", MACOS_LAUNCH_SCRIPT, launchCommand],
  };
}

export function buildLinuxTerminalCommand(
  terminal: LinuxTerminalEmulator,
  runnerArgs: readonly string[],
  cwd: string,
  title: string,
): TerminalCommand {
  switch (terminal) {
    case "x-terminal-emulator":
      return { command: terminal, args: ["-T", title, "-e", ...runnerArgs] };
    case "gnome-terminal":
      return { command: terminal, args: ["--wait", `--working-directory=${cwd}`, "--", ...runnerArgs] };
    case "konsole":
      return { command: terminal, args: ["--separate", "--workdir", cwd, "-e", ...runnerArgs] };
    case "xfce4-terminal":
      return { command: terminal, args: ["--disable-server", `--working-directory=${cwd}`, "--execute", ...runnerArgs] };
    case "kitty":
      return { command: terminal, args: ["--single-instance=no", "--directory", cwd, "--title", title, ...runnerArgs] };
    case "xterm":
      return { command: terminal, args: ["-T", title, "-e", ...runnerArgs] };
  }
}

export function createUnixCliRunner(
  cwd: string,
  bridgeEnv: Record<string, string>,
  command: string,
  args: string[],
): UnixCliRunner {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-bridge-launch-"));
  const runnerPath = path.join(tempDir, "run-cli.sh");
  const pidFile = path.join(tempDir, "cli.pid");
  fs.writeFileSync(runnerPath, UNIX_RUNNER_SOURCE, { encoding: "utf8", mode: 0o700 });
  return {
    tempDir,
    pidFile,
    runnerArgs: [
      runnerPath,
      pidFile,
      cwd,
      bridgeEnv.ANTHROPIC_BASE_URL ?? "",
      bridgeEnv.ANTHROPIC_AUTH_TOKEN ?? "",
      bridgeEnv.OPENAI_API_BASE ?? "",
      bridgeEnv.OPENAI_API_KEY ?? "",
      bridgeEnv.OPENCODE_CONFIG_CONTENT ?? "",
      command,
      ...args,
    ],
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function unrefDelay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function cleanupRecord(record: NativeLaunchRecord): void {
  if (record.monitor) clearInterval(record.monitor);
  nativeLaunches.delete(record);
  void fs.promises.rm(record.tempDir, { recursive: true, force: true });
}

async function readCliPid(record: NativeLaunchRecord): Promise<number | null> {
  try {
    const raw = await fs.promises.readFile(record.pidFile, "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

async function captureCliPid(record: NativeLaunchRecord): Promise<void> {
  for (let attempt = 0; attempt < 100 && nativeLaunches.has(record); attempt++) {
    const pid = await readCliPid(record);
    if (pid) {
      record.cliPid = pid;
      record.monitor = setInterval(() => {
        if (!record.cliPid || !processIsAlive(record.cliPid)) cleanupRecord(record);
      }, 500);
      record.monitor.unref();
      return;
    }
    await unrefDelay(50);
  }
  if (record.child.exitCode !== null) cleanupRecord(record);
}

function parseMacTarget(record: NativeLaunchRecord, stdout: Buffer[]): void {
  const output = Buffer.concat(stdout).toString("utf8").trim();
  const match = /^(\d+)\|(.+)$/m.exec(output);
  if (!match) return;
  const windowId = Number.parseInt(match[1]!, 10);
  if (Number.isSafeInteger(windowId) && windowId > 0) record.macWindowId = windowId;
  record.macTty = match[2]!.trim();
}

export async function launchNativeTerminal(
  tool: CliTool,
  args: string[],
  cwd: string,
  bridgeEnv: Record<string, string>,
  send: (event: LaunchEvent) => void,
  options: NativeLaunchOptions = {},
): Promise<ChildProcess | null> {
  const platform = options.platform ?? process.platform;
  const commandAvailable = options.commandAvailable ?? isCommandAvailable;
  const pathAvailable = options.pathAvailable ?? fs.existsSync;
  const command = tool === "claude" ? "claude" : "opencode";
  const resolvedCwd = resolveUnixWorkDir(cwd);

  if (platform !== "darwin" && platform !== "linux") {
    send({ type: "error", message: `Native terminal launch is not supported on ${platform}.` });
    return null;
  }
  if (!fs.existsSync(resolvedCwd)) {
    send({ type: "error", message: `Directory not found: ${resolvedCwd}` });
    return null;
  }
  if (!(await commandAvailable(command))) {
    send({ type: "error", message: `${command} executable was not found in the Bridge PATH. Install it or start it manually.` });
    return null;
  }

  let linuxTerminal: LinuxTerminalEmulator | null = null;
  if (platform === "darwin") {
    if (!(await isMacTerminalLaunchAvailable(commandAvailable, pathAvailable))) {
      send({ type: "error", message: "Terminal.app or osascript is not available on this macOS system." });
      return null;
    }
  } else {
    linuxTerminal = await findLinuxTerminalEmulator(commandAvailable);
    if (!linuxTerminal) {
      send({ type: "error", message: "No supported terminal emulator found. Start the CLI manually." });
      return null;
    }
  }

  const runner = createUnixCliRunner(resolvedCwd, bridgeEnv, command, args);
  const title = tool === "claude" ? "DeepSeek Bridge — Claude Code" : "DeepSeek Bridge — OpenCode";
  const terminalCommand = platform === "darwin"
    ? buildMacTerminalCommand(runner.runnerArgs)
    : buildLinuxTerminalCommand(linuxTerminal!, runner.runnerArgs, resolvedCwd, title);
  const stdout: Buffer[] = [];

  send({ type: "progress", step: "launch", message: `Starting ${tool === "claude" ? "Claude Code" : "OpenCode"} in ${platform === "darwin" ? "Terminal.app" : linuxTerminal}` });
  send({ type: "progress", step: "launch", message: `Working directory: ${resolvedCwd}` });

  let child: ChildProcess;
  try {
    child = spawn(terminalCommand.command, terminalCommand.args, {
      cwd: resolvedCwd,
      env: { ...process.env, ...bridgeEnv },
      stdio: platform === "darwin" ? ["ignore", "pipe", "ignore"] : "ignore",
      detached: true,
      shell: false,
    });
  } catch (error) {
    fs.rmSync(runner.tempDir, { recursive: true, force: true });
    send({ type: "error", message: `Failed to start terminal: ${error instanceof Error ? error.message : String(error)}` });
    return null;
  }

  const record: NativeLaunchRecord = { child, platform, tempDir: runner.tempDir, pidFile: runner.pidFile };
  nativeLaunches.add(record);
  if (platform === "darwin") {
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
    });
  }
  child.once("spawn", () => {
    send({ type: "result", ok: true, message: `${command} launched in a new visible terminal` });
  });
  child.once("error", error => {
    cleanupRecord(record);
    send({ type: "error", message: `Failed to start ${terminalCommand.command}: ${error.message}` });
  });
  child.once("close", code => {
    if (platform === "darwin") parseMacTarget(record, stdout);
    if (code !== 0 && !record.cliPid) {
      send({ type: "error", message: `${terminalCommand.command} exited before the CLI started (code ${code}).` });
    }
  });
  child.unref();
  void captureCliPid(record);
  return child;
}

function closeMacTerminalWindow(windowId: number, tty: string): Promise<void> {
  return new Promise(resolve => {
    const child = spawn("osascript", ["-e", MACOS_CLOSE_SCRIPT, String(windowId), tty], {
      stdio: "ignore",
      shell: false,
    });
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("close", done);
    child.once("error", done);
  });
}

export async function stopNativeTerminalLaunches(): Promise<void> {
  const records = [...nativeLaunches];
  for (const record of records) {
    if (!record.cliPid) record.cliPid = (await readCliPid(record)) ?? undefined;
    if (record.cliPid && processIsAlive(record.cliPid)) {
      try { process.kill(record.cliPid, "SIGTERM"); } catch { /* best effort */ }
    }
    if (record.platform === "darwin" && record.macWindowId && record.macTty) {
      await closeMacTerminalWindow(record.macWindowId, record.macTty);
    }
    if (record.child.pid && record.child.exitCode === null) {
      try { record.child.kill("SIGTERM"); } catch { /* best effort */ }
    }
    cleanupRecord(record);
  }
}
