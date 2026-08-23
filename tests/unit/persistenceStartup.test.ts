import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppHandle } from "../../src/app.js";

const ENV_KEYS = ["HOST", "PORT", "DS_DATA_DIR", "DS_AUTH_FILE", "DS_SESSIONS_FILE"] as const;
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

async function expectPortCanListen(port: number): Promise<void> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("persistent session startup lifecycle", () => {
  it("loads persisted sessions before the HTTP server starts accepting requests", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "bridge-persistence-startup-"));
    const sessionsFile = join(dataDir, "sessions.json");
    const port = await freePort();
    let app: AppHandle | null = null;
    const persistedSession = {
      sessionId: "persisted-session",
      sidCookie: "synthetic-cookie",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await writeFile(sessionsFile, JSON.stringify({
      version: 1,
      sessions: [persistedSession],
      links: [{ callId: "persisted-call", upstreamKey: "persisted-upstream", createdAt: Date.now() }],
    }));
    process.env.HOST = "127.0.0.1";
    process.env.PORT = String(port);
    process.env.DS_DATA_DIR = dataDir;
    process.env.DS_AUTH_FILE = join(dataDir, "missing-auth.json");
    process.env.DS_SESSIONS_FILE = sessionsFile;

    try {
      app = buildApp();
      expect(app.sessionManager.listSessions()).toEqual([]);
      await app.server.start();
      expect(app.sessionManager.listSessions()).toEqual([persistedSession]);
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
    } finally {
      await app?.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("does not listen when persistence initialization fails", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "bridge-persistence-invalid-"));
    const sessionsFile = join(dataDir, "sessions.json");
    const port = await freePort();
    await writeFile(sessionsFile, "{ truncated");
    process.env.HOST = "127.0.0.1";
    process.env.PORT = String(port);
    process.env.DS_DATA_DIR = dataDir;
    process.env.DS_AUTH_FILE = join(dataDir, "missing-auth.json");
    process.env.DS_SESSIONS_FILE = sessionsFile;

    try {
      const app = buildApp();
      await expect(app.server.start()).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
      await expectPortCanListen(port);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
