import assert from "node:assert/strict";
import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { buildApp, type AppHandle } from "../src/app.js";
import { buildConfig } from "../src/config/env.js";
import {
  buildMacTerminalCommand,
  createUnixCliRunner,
  quotePosixShellArg,
} from "../src/server/terminalLaunch.js";
import {
  findLinuxTerminalEmulator,
  getSystemCapabilities,
  isCommandAvailable,
  MACOS_TERMINAL_APP_PATHS,
  type SystemCapabilities,
} from "../src/server/system.js";

const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(["win32", "darwin", "linux"]);
const ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_BASE",
  "OPENAI_API_KEY",
] as const;

const BRIDGE_ENV: Record<(typeof ENV_KEYS)[number], string> = {
  ANTHROPIC_BASE_URL: "http://127.0.0.1:19655",
  ANTHROPIC_AUTH_TOKEN: "platform-smoke-anthropic-placeholder",
  OPENAI_API_BASE: "http://127.0.0.1:19655/v1",
  OPENAI_API_KEY: "platform-smoke-openai-placeholder",
};

interface ChildResult {
  cwd: string;
  env: Record<string, string | undefined>;
}

function log(message: string): void {
  process.stdout.write(`[platform-smoke] ${message}\n`);
}

async function reserveLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "failed to reserve a loopback port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function runChild(command: string, args: string[], options: SpawnOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      settled = true;
      reject(new Error(`child timed out: ${command}`));
    }, 20_000);
    timer.unref();

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
    });
    child.once("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 500);
        reject(new Error(`child failed (${code ?? signal ?? "unknown"}): ${detail}`));
        return;
      }
      resolve(Buffer.concat(stdout));
    });
  });
}

async function readChildResult(file: string, expectedCwd: string): Promise<void> {
  const result = JSON.parse(await readFile(file, "utf8")) as ChildResult;
  assert.equal(result.cwd, expectedCwd, "child process received a different cwd");
  assert.ok(result.cwd.includes("Проекты Test folder ёжик"), "Unicode cwd was not preserved");
  for (const key of ENV_KEYS) {
    assert.equal(result.env[key], BRIDGE_ENV[key], `${key} was not propagated exactly`);
  }
}

async function runChildProbes(root: string, unicodeDir: string): Promise<void> {
  const probeFile = path.join(root, "child-probe.cjs");
  const directResult = path.join(root, "direct-child-result.json");
  await writeFile(probeFile, `const fs = require("node:fs");
const keys = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_BASE", "OPENAI_API_KEY"];
const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
fs.writeFileSync(process.argv[2], JSON.stringify({ cwd: process.cwd(), env }), "utf8");
`, { encoding: "utf8", mode: 0o600 });

  const childEnv = { ...process.env, ...BRIDGE_ENV };
  const expectedCwd = await realpath(unicodeDir);
  await runChild(process.execPath, [probeFile, directResult], {
    cwd: unicodeDir,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  await readChildResult(directResult, expectedCwd);
  log("safe-child=ok unicode-cwd=ok env-propagation=ok");

  if (process.platform === "win32") return;

  const runnerResult = path.join(root, "unix-runner-result.json");
  const runner = createUnixCliRunner(unicodeDir, BRIDGE_ENV, process.execPath, [probeFile, runnerResult]);
  try {
    const runnerCommand = runner.runnerArgs[0];
    assert.ok(runnerCommand, "POSIX runner command is missing");
    await runChild(runnerCommand, runner.runnerArgs.slice(1), {
      cwd: unicodeDir,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await readChildResult(runnerResult, expectedCwd);
    const recordedPid = Number.parseInt((await readFile(runner.pidFile, "utf8")).trim(), 10);
    assert.ok(Number.isSafeInteger(recordedPid) && recordedPid > 1, "POSIX runner did not record its child PID");
    log("production-posix-runner=ok");
  } finally {
    await rm(runner.tempDir, { recursive: true, force: true });
  }
}

async function validateMacTransport(unicodeDir: string): Promise<void> {
  const osascriptAvailable = await isCommandAvailable("osascript");
  const terminalAppAvailable = MACOS_TERMINAL_APP_PATHS.some(candidate => fs.existsSync(candidate));
  assert.equal(osascriptAvailable, true, "osascript is missing on the macOS runner");
  assert.equal(terminalAppAvailable, true, "Terminal.app is missing on the macOS runner");

  const samples = [
    "Test folder",
    "Проекты/ёжик",
    "single'quote",
    "special ; & $() ` ! [safe]",
  ];
  const shellCommand = `printf '%s\\n' ${samples.map(quotePosixShellArg).join(" ")}`;
  const stdout = await runChild("/bin/sh", ["-c", shellCommand], {
    cwd: unicodeDir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.deepEqual(stdout.toString("utf8").replace(/\n$/, "").split("\n"), samples);

  const terminalCommand = buildMacTerminalCommand(["/tmp/run-cli.sh", ...samples]);
  assert.equal(terminalCommand.command, "osascript");
  for (const sample of samples) {
    assert.ok(!terminalCommand.args[1]?.includes(sample), "user data leaked into AppleScript source");
    assert.ok(terminalCommand.args[2]?.includes(quotePosixShellArg(sample)), "quoted argv was not preserved");
  }
  log("macos-osascript=found terminal-app=found posix-quoting=ok gui-launch=not-run");
}

async function validatePlatformCapabilities(system: SystemCapabilities, unicodeDir: string): Promise<void> {
  if (process.platform === "win32") {
    assert.deepEqual(system, {
      platform: "win32",
      folderPicker: true,
      claudeCodeLaunch: true,
      openCodeLaunch: true,
    });
    log("windows-capabilities=ok interactive-cli-launch=not-run");
    return;
  }
  if (process.platform === "darwin") {
    await validateMacTransport(unicodeDir);
    assert.equal(system.folderPicker, true);
    assert.equal(system.claudeCodeLaunch, true);
    assert.equal(system.openCodeLaunch, true);
    return;
  }

  const terminal = await findLinuxTerminalEmulator();
  const expectedLaunchCapability = terminal !== null;
  assert.equal(system.claudeCodeLaunch, expectedLaunchCapability);
  assert.equal(system.openCodeLaunch, expectedLaunchCapability);
  if (terminal === null) {
    assert.equal(system.claudeCodeLaunch, false);
    log("linux-terminal=not-found launch-capabilities=false gui-launch=not-run");
  } else {
    log(`linux-terminal=${terminal} launch-capabilities=true gui-launch=not-run`);
  }
}

async function fetchJson<T>(url: string, expectedStatus: number): Promise<T> {
  const response = await fetch(url);
  assert.equal(response.status, expectedStatus, `${url} returned HTTP ${response.status}`);
  return await response.json() as T;
}

async function main(): Promise<void> {
  assert.ok(SUPPORTED_PLATFORMS.has(process.platform), `unsupported platform: ${process.platform}`);
  log(`platform=${process.platform}`);

  const smokeRoot = await mkdtemp(path.join(os.tmpdir(), "deepseek-bridge-platform-"));
  const unicodeDir = path.join(smokeRoot, "Проекты Test folder ёжик ' ; & $ [safe]");
  const dataDir = path.join(smokeRoot, "bridge-data");
  await mkdir(unicodeDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const port = await reserveLoopbackPort();
  const envOverrides: Record<string, string> = {
    HOST: "127.0.0.1",
    PORT: String(port),
    DS_DATA_DIR: dataDir,
    DS_AUTH_FILE: path.join(dataDir, "auth.json"),
    DS_SESSIONS_FILE: path.join(dataDir, "sessions.json"),
    DS_CHROME_PROFILE: path.join(dataDir, "chrome-profile"),
    DS_BASE_URL: "http://127.0.0.1:1",
    DS_DEBUG: "0",
    PROXY_API_KEY: "",
    PROXY_CORS_ORIGINS: "",
  };
  const previousEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(envOverrides)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  let app: AppHandle | null = null;
  let started = false;
  try {
    const config = buildConfig();
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, port);
    assert.equal(config.dataDir, dataDir);
    assert.equal(config.authFile, path.join(dataDir, "auth.json"));
    assert.equal(fs.existsSync(config.authFile), false, "platform smoke must not use an auth file");
    log("build-config=ok auth=not-used");

    app = buildApp();
    await app.server.start();
    started = true;
    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await fetchJson<{ status: string }>(`${baseUrl}/health`, 200);
    assert.equal(health.status, "ok");
    const ready = await fetchJson<{ ready: boolean }>(`${baseUrl}/readyz`, 200);
    assert.equal(ready.ready, true);
    const system = await fetchJson<SystemCapabilities>(`${baseUrl}/api/system`, 200);
    const directSystem = await getSystemCapabilities();
    assert.deepEqual(system, directSystem, "/api/system did not reflect backend capabilities");
    assert.equal(system.platform, process.platform);
    log(`bridge-http=ok system=${JSON.stringify(system)}`);

    await validatePlatformCapabilities(system, unicodeDir);
    await runChildProbes(smokeRoot, unicodeDir);
  } finally {
    if (app && started) await app.stop();
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(smokeRoot, { recursive: true, force: true });
  }

  log("cleanup=ok result=pass desktop-gui-live-test=not-run");
}

main().catch(error => {
  process.stderr.write(`[platform-smoke] result=fail ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
