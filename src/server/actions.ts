import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { ServerResponse } from "node:http";
import { buildConfig } from "../config/env.js";
import { writeJsonAtomic, readJsonIfExists } from "../utils/atomicFile.js";
import { isRecord } from "../utils/json.js";
import { Redactor } from "../utils/redaction.js";
import { Logger } from "../utils/logger.js";
import { PowSolver, parseChallengePayload } from "../deepseek/pow.js";
import { SseAccumulator } from "../deepseek/sseParser.js";
import { parseUpdateChunk } from "../deepseek/updateParser.js";
import { COMPLETION_PATH, SESSION_CREATE_PATH, CLIENT_HEADERS, BROWSER_HEADERS, UPSTREAM_USER_AGENT } from "../config/constants.js";
import { CdpConnection, createPage, launchChrome, waitForDebugger, findChrome } from "../cdp.js";

const CDP_PORT = 9222;

export interface ActionEvent {
  type: "progress" | "result" | "error" | "log";
  step?: string;
  ok?: boolean;
  message?: string;
  data?: unknown;
}

export function writeSSE(res: ServerResponse, event: ActionEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function endSSE(res: ServerResponse): void {
  res.write("data: [DONE]\n\n");
  res.end();
}

/* ── AUTH STATUS CHECK ── */

export async function checkAuthStatus(): Promise<{ valid: boolean; message: string }> {
  const config = buildConfig();
  try {
    const raw = await readJsonIfExists(config.authFile);
    if (!isRecord(raw)) return { valid: false, message: "No auth.json found" };
    const token = typeof raw.token === "string" ? raw.token : "";
    const cookie = typeof raw.cookie === "string" ? raw.cookie : "";
    if (!token && !cookie) return { valid: false, message: "No credentials in auth.json" };
    const res = await fetch(`${config.baseUrl}/api/v0/auth/session`, {
      headers: { authorization: `Bearer ${token}`, cookie, ...CLIENT_HEADERS, ...BROWSER_HEADERS, "user-agent": UPSTREAM_USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { valid: false, message: `Upstream HTTP ${res.status}` };
    const json = await res.json() as Record<string, unknown>;
    const code = typeof json.code === "number" ? json.code : 0;
    if (code === 40003) return { valid: false, message: `AUTH INVALID (code 40003)` };
    if (code !== 0) {
      const msg = typeof json.msg === "string" ? json.msg : `code ${code}`;
      return { valid: false, message: `AUTH INVALID (${msg})` };
    }
    return { valid: true, message: `Auth OK (${token.slice(0, 12)}...)` };
  } catch (error) {
    return { valid: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/* ── QUICK DIAGNOSTICS (local checks, no upstream PoW/completion) ── */

export async function runDiagnosticsSSE(send: (event: ActionEvent) => void): Promise<void> {
  const config = buildConfig();

  // Check auth file
  let hasAuth = false;
  await (async () => {
    try {
      const raw = await readJsonIfExists(config.authFile);
      if (!isRecord(raw)) throw new Error("missing");
      const token = typeof raw.token === "string" ? raw.token : "";
      const cookie = typeof raw.cookie === "string" ? raw.cookie : "";
      if (!token && !cookie) throw new Error("no credentials");
      hasAuth = true;
      send({ type: "progress", step: "auth_file", ok: true, message: `Present (${token.slice(0, 12)}...)` });
    } catch (error) {
      send({ type: "progress", step: "auth_file", ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  })();

  // Check upstream reachability
  if (hasAuth) {
    try {
      const raw = await readJsonIfExists(config.authFile);
      const data = isRecord(raw) ? raw : {};
      const token = typeof data.token === "string" ? data.token : "";
      const cookie = typeof data.cookie === "string" ? data.cookie : "";
      const res = await fetch(`${config.baseUrl}/api/v0/auth/session`, {
        headers: { authorization: `Bearer ${token}`, cookie, ...CLIENT_HEADERS, ...BROWSER_HEADERS, "user-agent": UPSTREAM_USER_AGENT },
        signal: AbortSignal.timeout(8000),
      });
      send({ type: "progress", step: "upstream", ok: res.ok, message: `HTTP ${res.status}` });
    } catch (error) {
      send({ type: "progress", step: "upstream", ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  } else {
    send({ type: "progress", step: "upstream", ok: false, message: "skipped: no auth" });
  }

  // Check bridge server health
  try {
    const res = await fetch(`http://127.0.0.1:${config.port ?? 9655}/health`, { signal: AbortSignal.timeout(3000) });
    send({ type: "progress", step: "bridge_server", ok: res.ok, message: res.ok ? "Healthy" : `HTTP ${res.status}` });
  } catch (error) {
    send({ type: "progress", step: "bridge_server", ok: false, message: error instanceof Error ? error.message : String(error) });
  }

  // Check data directory permissions
  try {
    const info = await import("node:fs/promises").then(fs => fs.stat(config.dataDir));
    send({ type: "progress", step: "data_dir", ok: info.isDirectory(), message: info.isDirectory() ? "Exists" : "Not a directory" });
  } catch {
    send({ type: "progress", step: "data_dir", ok: false, message: "Not found" });
  }

  send({ type: "result", ok: true, message: "Diagnostics complete" });
}

/* ── AUTH ── */

const LOCAL_STORAGE_SCAN = `
(function () {
  const found = { token: null, cookie: null };
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      let value;
      try { value = localStorage.getItem(key); } catch { continue; }
      if (!value) continue;
      if (typeof value === "string" && /^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$/.test(value) && value.length > 40) {
        if (/token|auth|bearer|user/i.test(key)) { found.token = value; }
      }
      if (!found.token && value.length > 60 && /token|auth|bearer|user/i.test(key) && /^[A-Za-z0-9_-]{20,}$/.test(value)) {
        found.token = value;
      }
    }
  } catch { /* origin not accessible */ }
  try {
    const raw = document.cookie;
    if (raw && raw.length > 3) found.cookie = raw;
  } catch { /* noop */ }
  return found;
})();
`;

async function scanPageStorage(conn: CdpConnection): Promise<{ token?: string; cookie?: string }> {
  try {
    const result = await conn.send("Runtime.evaluate", { expression: LOCAL_STORAGE_SCAN, returnByValue: true });
    const inner = result.result as { value?: unknown } | undefined;
    const value = inner?.value as { token?: string | null; cookie?: string | null } | undefined;
    const out: { token?: string; cookie?: string } = {};
    if (value?.token) out.token = value.token;
    if (value?.cookie) out.cookie = value.cookie;
    return out;
  } catch { return {}; }
}

async function getFullCookie(conn: CdpConnection): Promise<string> {
  try {
    const result = await conn.send("Network.getCookies", { urls: ["https://chat.deepseek.com"] });
    const cookies = result.cookies as Array<{ name: string; value: string }> | undefined;
    if (!cookies || !Array.isArray(cookies)) return "";
    return cookies.map(c => `${c.name}=${c.value}`).join("; ");
  } catch { return ""; }
}

interface CapturedAuth {
  token: string;
  cookie: string;
  hifDliq?: string;
  hifLeim?: string;
}

export async function runAuthSSE(
  send: (event: ActionEvent) => void,
  signal?: AbortSignal,
): Promise<CapturedAuth | null> {
  const config = buildConfig();
  const baseHost = new URL(config.baseUrl).hostname;

  if (!findChrome(config.chromePath)) {
    send({ type: "error", message: "Chrome not found. Set CHROME_PATH environment variable." });
    return null;
  }

  send({ type: "progress", step: "chrome", message: "Launching Chrome..." });

  if (fs.existsSync(config.authFile)) {
    fs.rmSync(config.authFile, { force: true });
  }

  if (fs.existsSync(config.chromeProfile)) {
    fs.rmSync(config.chromeProfile, { recursive: true, force: true });
  }

  const child = launchChrome({
    profileDir: config.chromeProfile,
    remoteDebugPort: CDP_PORT,
    chromePath: config.chromePath,
  });

  let conn: CdpConnection | null = null;

  const cleanup = () => {
    if (conn) { try { conn.close(); } catch {} }
    try { child.kill(); } catch {}
  };

  if (signal) {
    signal.addEventListener("abort", () => { cleanup(); }, { once: true });
  }

  try {
    await waitForDebugger(CDP_PORT, 20_000);
    send({ type: "progress", step: "chrome", message: "Chrome ready, opening DeepSeek..." });

    const debugUrl = await createPage(CDP_PORT);
    conn = await CdpConnection.connect(debugUrl);

    await conn.send("Page.enable");
    await conn.send("Network.enable");
    await conn.send("Fetch.enable", {
      patterns: [{ urlPattern: "*://chat.deepseek.com/api/v0/*" }],
    });
    await conn.send("Page.navigate", { url: config.baseUrl });

    send({ type: "progress", step: "auth", message: "Browser open. Log in to DeepSeek, then send a message (e.g. 'hi')." });

    const captured: Partial<CapturedAuth> = {};
    let requestsSeen = 0;
    let requestsWithAuth = 0;
    let hifSeen = false;

    conn.on("Fetch.requestPaused", (params: Record<string, unknown>) => {
      const req = params.request as { url?: string; headers?: Record<string, string> } | undefined;
      const requestId = params.requestId as string;
      conn!.send("Fetch.continueRequest", { requestId }).catch(() => {});

      if (!req?.headers) return;
      const url = req.url ?? "";
      if (!url.includes(baseHost) || !url.includes("/api/v0/")) return;

      requestsSeen++;
      const headers = req.headers;
      const auth = headers.authorization ?? headers.Authorization ?? "";
      if (auth && auth.startsWith("Bearer ")) {
        captured.token = auth.slice("Bearer ".length).trim();
        requestsWithAuth++;
      }
      const hifLeim = headers["x-hif-leim"];
      if (hifLeim) {
        captured.hifLeim = hifLeim;
        hifSeen = true;
      }
    });

    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      if (signal?.aborted) { cleanup(); return null; }

      if (captured.token && captured.hifLeim) {
        send({ type: "progress", step: "auth", message: "Credentials captured, finalizing..." });
        await new Promise(resolve => setTimeout(resolve, 3000));
        const fullCookie = await getFullCookie(conn);

        let hifLeim = captured.hifLeim;
        try {
          const lsResult = await conn.send("Runtime.evaluate", {
            expression: `localStorage.getItem("hif_leim_cached")`,
            returnByValue: true,
          });
          const lsVal = (lsResult.result as { value?: string })?.value;
          if (lsVal) hifLeim = lsVal.replace(/^"|"$/g, "");
        } catch {}

        const auth: CapturedAuth = {
          token: captured.token,
          cookie: fullCookie,
          hifDliq: captured.hifDliq,
          hifLeim,
        };

        send({ type: "progress", step: "auth", message: "Verifying credentials..." });
        try {
          const verifyRes = await fetch(`${config.baseUrl}${SESSION_CREATE_PATH}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...CLIENT_HEADERS, ...BROWSER_HEADERS, "user-agent": UPSTREAM_USER_AGENT, authorization: `Bearer ${auth.token}`, cookie: auth.cookie, ...(auth.hifLeim ? { "x-hif-leim": auth.hifLeim } : {}), ...(auth.hifDliq ? { "x-hif-dliq": auth.hifDliq } : {}) },
            body: JSON.stringify({}),
            signal: AbortSignal.timeout(15000),
          });
          const verifyJson = await verifyRes.json() as Record<string, unknown>;
          const verifyCode = typeof verifyJson.code === "number" ? verifyJson.code : 0;
          const verifyData = isRecord(verifyJson.data) ? verifyJson.data : {};
          const bizCode = typeof verifyData.biz_code === "number" ? verifyData.biz_code : 0;
          if (verifyCode !== 0 || bizCode !== 0) {
            const verifyMsg = typeof verifyJson.msg === "string" ? verifyJson.msg : `code ${verifyCode}`;
            const bizMsg = typeof verifyData.biz_msg === "string" ? verifyData.biz_msg : bizCode !== 0 ? `biz_code ${bizCode}` : "";
            const detail = bizMsg ? `${verifyMsg}: ${bizMsg}` : verifyMsg;
            send({ type: "error", step: "auth", message: `Credentials invalid: ${detail}. auth.json NOT saved.` });
            cleanup();
            return null;
          }
        } catch (err) {
          send({ type: "error", step: "auth", message: `Credential verification failed: ${err instanceof Error ? err.message : String(err)}. auth.json NOT saved.` });
          cleanup();
          return null;
        }

        fs.mkdirSync(path.dirname(config.authFile), { recursive: true });
        await writeJsonAtomic(config.authFile, auth, 0o600);

        send({ type: "result", step: "auth", ok: true, message: `Auth saved. Token: ${auth.token.slice(0, 12)}...` });
        cleanup();
        return auth;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    send({ type: "error", step: "auth", message: `Timeout: ${requestsSeen} API requests seen, ${requestsWithAuth} with Bearer, hif-leim: ${hifSeen}. Send a message after login.` });
    cleanup();
    return null;
  } catch (error) {
    send({ type: "error", step: "auth", message: error instanceof Error ? error.message : String(error) });
    cleanup();
    return null;
  }
}

/* ── DOCTOR ── */

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export async function runDoctorSSE(
  send: (event: ActionEvent) => void,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await Promise.resolve().then(fn);
      results.push({ name, ok: true });
      send({ type: "progress", step: name, ok: true, message: "OK" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ name, ok: false, detail });
      send({ type: "progress", step: name, ok: false, message: detail });
    }
  }

  const config = buildConfig();
  let authState: { token: string; cookie: string; hifLeim?: string; hifDliq?: string; baseUrl: string } | null = null;

  await check("auth file present", async () => {
    const raw = await readJsonIfExists(config.authFile);
    if (!isRecord(raw)) throw new Error(`Missing ${config.authFile}`);
    const token = typeof raw.token === "string" ? raw.token : "";
    const cookie = typeof raw.cookie === "string" ? raw.cookie : "";
    if (!token && !cookie) throw new Error("No token/cookie in auth.json");
    const hifLeim = typeof raw.hifLeim === "string" ? raw.hifLeim
      : typeof raw.hif_leim === "string" ? raw.hif_leim : undefined;
    const hifDliq = typeof raw.hifDliq === "string" ? raw.hifDliq
      : typeof raw.hif_dliq === "string" ? raw.hif_dliq : undefined;
    authState = { token, cookie, hifLeim, hifDliq, baseUrl: config.baseUrl };
  });

  const auth = authState!;

  await check("deepseek reachable", async () => {
    if (!authState) throw new Error("skipped");
    const res = await fetch(`${auth.baseUrl}/api/v0/auth/session`);
    if (res.status !== 404 && res.status !== 200 && res.status >= 400) throw new Error(`HTTP ${res.status}`);
  });

  let challengePayload: ReturnType<typeof parseChallengePayload> | null = null;
  await check("pow challenge", async () => {
    if (!authState) throw new Error("skipped");
    const res = await fetch(`${auth.baseUrl}/api/v0/chat/create_pow_challenge`, {
      method: "POST",
      headers: { "content-type": "application/json", ...CLIENT_HEADERS, ...BROWSER_HEADERS, "user-agent": UPSTREAM_USER_AGENT, authorization: `Bearer ${auth.token}`, cookie: auth.cookie, ...(auth.hifLeim ? { "x-hif-leim": auth.hifLeim } : {}), ...(auth.hifDliq ? { "x-hif-dliq": auth.hifDliq } : {}) },
      body: JSON.stringify({ target_path: COMPLETION_PATH }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as Record<string, unknown>;
    const code = typeof json.code === "number" ? json.code : 0;
    if (code !== 0) {
      const msg = typeof json.msg === "string" ? json.msg : `code ${code}`;
      throw new Error(`API error: ${msg}`);
    }
    const data = isRecord(json.data) ? json.data : {};
    const bizCode = typeof data.biz_code === "number" ? data.biz_code : 0;
    if (bizCode !== 0) {
      const bizMsg = typeof data.biz_msg === "string" ? data.biz_msg : `biz_code ${bizCode}`;
      throw new Error(`API biz error: ${bizMsg}`);
    }
    challengePayload = parseChallengePayload(json);
    if (!challengePayload) throw new Error("challenge format not recognized");
  });

  const redactor = new Redactor({ secrets: [auth.token, auth.cookie] });
  const logger = new Logger({ level: "warn", redactor });
  const solver = new PowSolver({ wasmCacheDir: path.join(config.dataDir), logger });
  let solution: { answer: number; signature: string; algorithm: string; salt: string; challenge: string } | null = null;

  await check("pow solved", async () => {
    if (!challengePayload) throw new Error("skipped");
    solution = await solver.solve(challengePayload);
  });

  let completionBody: unknown = null;
  await check("completion SSE parsed", async () => {
    if (!authState || !challengePayload || !solution) throw new Error("skipped");
    const sessionRes = await fetch(`${auth.baseUrl}${SESSION_CREATE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...CLIENT_HEADERS, ...BROWSER_HEADERS, "user-agent": UPSTREAM_USER_AGENT, authorization: `Bearer ${auth.token}`, cookie: auth.cookie, ...(auth.hifLeim ? { "x-hif-leim": auth.hifLeim } : {}), ...(auth.hifDliq ? { "x-hif-dliq": auth.hifDliq } : {}) },
      body: JSON.stringify({}),
    });
    if (!sessionRes.ok) throw new Error(`session HTTP ${sessionRes.status}`);
    const sessionJson = await sessionRes.json() as Record<string, unknown>;
    const sessionData = isRecord(sessionJson.data) ? sessionJson.data : {};
    const bizData = isRecord(sessionData.biz_data) ? sessionData.biz_data : sessionData;
    let chatSessionId = typeof bizData.id === "string" ? bizData.id : "";
    if (!chatSessionId && isRecord(bizData.chat_session) && typeof bizData.chat_session.id === "string") chatSessionId = bizData.chat_session.id;
    if (!chatSessionId) throw new Error("no chat_session_id");

    const res = await fetch(`${auth.baseUrl}${COMPLETION_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json", ...CLIENT_HEADERS, ...BROWSER_HEADERS,
        "user-agent": UPSTREAM_USER_AGENT, authorization: `Bearer ${auth.token}`, cookie: auth.cookie,
        ...(auth.hifLeim ? { "x-hif-leim": auth.hifLeim } : {}),
        ...(auth.hifDliq ? { "x-hif-dliq": auth.hifDliq } : {}),
        "x-ds-pow-response": Buffer.from(JSON.stringify({ algorithm: solution!.algorithm, challenge: solution!.challenge, salt: solution!.salt, answer: solution!.answer, signature: solution!.signature, target_path: COMPLETION_PATH })).toString("base64"),
      },
      body: JSON.stringify({
        chat_session_id: chatSessionId, parent_message_id: null, prompt: "Say OK only.",
        ref_file_ids: [], model_name: "deepseek-chat", thinking_enabled: false, search_enabled: false,
        messages: [{ id: "msg_1", role: "user", content: "Say OK only.", content_type: "text" }], additional_input: {},
      }),
    });
    if (!res.ok) throw new Error(`completion HTTP ${res.status}`);
    if (!res.body) throw new Error("empty body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const acc = new SseAccumulator();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of acc.push(decoder.decode(value, { stream: true }))) {
        if (event.type === "update") {
          const chunk = parseUpdateChunk(event.data);
          if (chunk?.delta) text += chunk.delta;
        }
      }
    }
    if (!text.trim()) throw new Error("no text in stream");
    completionBody = { text: text.slice(0, 80) };
  });

  await check("completion content", async () => {
    const body = completionBody as { text: string } | null;
    if (!body?.text) throw new Error("no content");
  });

  const failed = results.filter(r => !r.ok);
  send({ type: "result", ok: failed.length === 0, message: failed.length === 0 ? "All checks passed" : `${failed.length}/${results.length} failed`, data: results });
  return results;
}

/* ── LAUNCH ── */

function getBridgeEnv(): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:9655",
    ANTHROPIC_AUTH_TOKEN: "local-key",
    OPENAI_API_BASE: "http://127.0.0.1:9655/v1",
    OPENAI_API_KEY: "local-key",
  };
}

export function launchProcess(
  command: string,
  args: string[],
  cwd: string,
  send: (event: ActionEvent) => void,
  extraEnv?: Record<string, string>,
): ChildProcess | null {
  if (!fs.existsSync(cwd)) {
    send({ type: "error", message: `Directory not found: ${cwd}` });
    return null;
  }

  const env = { ...process.env, ...extraEnv };
  send({ type: "progress", step: "launch", message: `Starting: ${command} ${args.join(" ")}` });
  send({ type: "progress", step: "launch", message: `Working directory: ${cwd}` });

  const child = spawn(command, args, {
    cwd,
    env,
    stdio: "ignore",
    detached: true,
    shell: true,
  });

  child.on("error", (err) => {
    send({ type: "error", message: `Failed to start ${command}: ${err.message}` });
  });
  child.on("close", (code) => {
    send({ type: "result", ok: code === 0, message: `${command} exited (code ${code})` });
  });

  // Unref so the bridge server doesn't wait for the child
  child.unref();

  send({ type: "result", ok: true, message: `${command} launched in new window` });
  return child;
}

export function launchClaudeCode(workDir: string, model: string, send: (event: ActionEvent) => void): ChildProcess | null {
  const args: string[] = [];
  if (model) args.push("--model", model);
  const child = launchProcess("claude", args, workDir, send, getBridgeEnv());
  trackProcess(child);
  return child;
}

export function launchOpenCode(workDir: string, model: string, send: (event: ActionEvent) => void): ChildProcess | null {
  const child = launchProcess("opencode", [], workDir, send, getBridgeEnv());
  trackProcess(child);
  return child;
}

/* ── PROCESS TRACKING ── */

const launchedProcesses: Set<ChildProcess> = new Set();

export function trackProcess(child: ChildProcess | null): void {
  if (child) {
    launchedProcesses.add(child);
    child.on("close", () => { launchedProcesses.delete(child); });
  }
}

export async function stopLaunchedProcesses(): Promise<void> {
  for (const child of launchedProcesses) {
    try {
      const pid = child.pid;
      if (pid && process.platform === "win32") {
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGTERM");
      }
    } catch { /* best effort */ }
  }
  launchedProcesses.clear();
}

/* ── FOLDER PICKER ── */

export interface PickFolderResult {
  path: string | null;
  cancelled: boolean;
  supported: boolean;
}

export async function pickFolder(): Promise<PickFolderResult> {
  if (process.platform !== "win32") return { path: null, cancelled: false, supported: false };

  const ps = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$f = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$f.Description = 'Select working directory'",
    "$f.ShowNewFolderButton = $true",
    "if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }",
  ].join("; ");

  return new Promise<PickFolderResult>((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-Command", ps], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on("close", () => {
      const trimmed = stdout.trim();
      if (trimmed) {
        resolve({ path: trimmed, cancelled: false, supported: true });
      } else {
        resolve({ path: null, cancelled: true, supported: true });
      }
    });
    child.on("error", () => { resolve({ path: null, cancelled: false, supported: true }); });
  });
}

/* ── LOGOUT ── */

export async function performLogout(): Promise<{ ok: boolean; message: string }> {
  const config = buildConfig();
  try {
    if (fs.existsSync(config.authFile)) {
      fs.rmSync(config.authFile, { force: true });
    }
    if (fs.existsSync(config.chromeProfile)) {
      fs.rmSync(config.chromeProfile, { recursive: true, force: true });
    }
    return { ok: true, message: "Logged out. Bridge stopped." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
