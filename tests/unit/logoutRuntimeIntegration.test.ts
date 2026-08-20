import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type AppHandle } from "../../src/app.js";

const ENV_KEYS = [
  "HOST",
  "PORT",
  "DS_DATA_DIR",
  "DS_AUTH_FILE",
  "DS_CHROME_PROFILE",
  "DS_SESSIONS_FILE",
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Web UI logout runtime", () => {
  it("keeps the same HTTP Bridge available after deleting auth on a Unicode path", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "bridge-logout-ёжик-"));
    const authFile = join(dataDir, "auth.json");
    const chromeProfile = join(dataDir, "chrome-profile");
    const sessionsFile = join(dataDir, "sessions.json");
    const port = await freePort();
    let app: AppHandle | null = null;

    process.env.HOST = "127.0.0.1";
    process.env.PORT = String(port);
    process.env.DS_DATA_DIR = dataDir;
    process.env.DS_AUTH_FILE = authFile;
    process.env.DS_CHROME_PROFILE = chromeProfile;
    process.env.DS_SESSIONS_FILE = sessionsFile;

    await mkdir(join(chromeProfile, "Default"), { recursive: true });
    await writeFile(authFile, JSON.stringify({ token: "test_token_123", cookie: "test_cookie_123" }));
    await writeFile(join(chromeProfile, "Default", "Preferences"), "{}");
    await writeFile(sessionsFile, JSON.stringify({ version: 1, sessions: [], links: [] }));

    try {
      app = buildApp();
      await app.server.start();
      const baseUrl = `http://127.0.0.1:${port}`;

      const healthBefore = await fetch(`${baseUrl}/health`);
      const authBefore = await fetch(`${baseUrl}/bridge/auth-status`);
      expect(healthBefore.status).toBe(200);
      expect(await authBefore.json()).toEqual({ valid: true, message: "AUTH SAVED" });

      const logout = await fetch(`${baseUrl}/bridge/logout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(logout.status).toBe(200);
      expect(await logout.json()).toEqual({ ok: true, message: "Logged out" });

      const healthAfter = await fetch(`${baseUrl}/health`);
      const readyAfter = await fetch(`${baseUrl}/readyz`);
      const authAfter = await fetch(`${baseUrl}/bridge/auth-status`);
      expect(healthAfter.status).toBe(200);
      expect(await healthAfter.json()).toEqual({ status: "ok" });
      expect(readyAfter.status).toBe(200);
      expect(await authAfter.json()).toEqual({ valid: false, message: "NO AUTH" });
      expect(existsSync(authFile)).toBe(false);
      expect(existsSync(chromeProfile)).toBe(false);
    } finally {
      await app?.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
