import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthSession } from "../../src/auth/session.js";
import { FileSessionStorage } from "../../src/auth/storage.js";
import { SessionManager } from "../../src/auth/sessionManager.js";
import { LineageStore } from "../../src/sessions/lineage.js";
import { PersistentSessionDocument } from "../../src/sessions/persistentSessionDocument.js";
import { writeJsonAtomic } from "../../src/utils/atomicFile.js";

let root: string;
let file: string;

const sessionA: AuthSession = {
  sessionId: "session-A",
  sidCookie: "synthetic-A",
  createdAt: 1_000,
  updatedAt: 1_000,
  name: "A",
};
const sessionB: AuthSession = {
  sessionId: "session-B",
  sidCookie: "synthetic-B",
  createdAt: 2_000,
  updatedAt: 2_000,
  name: "B",
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "persistent-session-document-"));
  file = join(root, "sessions.json");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function stores(target = file): Promise<{
  document: PersistentSessionDocument;
  sessions: FileSessionStorage;
  lineage: LineageStore;
}> {
  const document = new PersistentSessionDocument(target);
  await document.init();
  const sessions = new FileSessionStorage(document);
  const lineage = new LineageStore(document);
  await lineage.init();
  return { document, sessions, lineage };
}

async function persisted(target = file): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
}

describe("PersistentSessionDocument PB31 persistence and restart", () => {
  it("T1: session -> lineage preserves the session", async () => {
    const current = await stores();
    await current.sessions.save({ [sessionA.sessionId]: sessionA });
    await current.lineage.record("call-A", "upstream-A");

    expect(await current.sessions.load()).toEqual({ [sessionA.sessionId]: sessionA });
    expect(current.lineage.getUpstreamKey("call-A")).toBe("upstream-A");
    expect(await persisted()).toMatchObject({ version: 2, sessions: [sessionA] });
  });

  it("T2: lineage -> session preserves lineage", async () => {
    const current = await stores();
    await current.lineage.record("call-A", "upstream-A");
    await current.sessions.save({ [sessionA.sessionId]: sessionA });

    expect(current.lineage.getUpstreamKey("call-A")).toBe("upstream-A");
    expect(await persisted()).toMatchObject({
      version: 2,
      sessions: [sessionA],
      links: [expect.objectContaining({ callId: "call-A", upstreamKey: "upstream-A" })],
    });
  });

  it("T3: interleaved session and lineage writes retain every field", async () => {
    const current = await stores();
    await current.sessions.save({ [sessionA.sessionId]: sessionA });
    await current.lineage.record("call-A", "upstream-A");
    await current.sessions.save({
      [sessionA.sessionId]: sessionA,
      [sessionB.sessionId]: sessionB,
    });
    await current.lineage.record("call-B", "upstream-B");

    expect(await current.sessions.load()).toEqual({
      [sessionA.sessionId]: sessionA,
      [sessionB.sessionId]: sessionB,
    });
    expect(current.lineage.getUpstreamKey("call-A")).toBe("upstream-A");
    expect(current.lineage.getUpstreamKey("call-B")).toBe("upstream-B");
  });

  it("T4: new owner and store instances restore sessions and lineage", async () => {
    const first = await stores();
    await first.sessions.save({ [sessionA.sessionId]: sessionA });
    await first.lineage.record("call-A", "upstream-A");

    const restarted = await stores();
    expect(await restarted.sessions.load()).toEqual({ [sessionA.sessionId]: sessionA });
    expect(restarted.lineage.getUpstreamKey("call-A")).toBe("upstream-A");
  });

  it("T5: FIFO serialization prevents a delayed older write from erasing a completed mutation", async () => {
    let writeCount = 0;
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const started = new Promise<void>(resolve => { firstStarted = resolve; });
    const document = new PersistentSessionDocument(file, {
      write: async (target, data, mode) => {
        writeCount++;
        if (writeCount === 1) {
          firstStarted();
          await firstGate;
        }
        await writeJsonAtomic(target, data, mode);
      },
    });
    await document.init();
    const sessions = new FileSessionStorage(document);
    const lineage = new LineageStore(document);
    await lineage.init();

    const sessionWrite = sessions.save({ [sessionA.sessionId]: sessionA });
    await started;
    const lineageWrite = lineage.record("call-A", "upstream-A");
    await Promise.resolve();
    expect(writeCount).toBe(1);
    releaseFirst();
    await Promise.all([sessionWrite, lineageWrite]);

    expect(writeCount).toBe(2);
    expect(await persisted()).toMatchObject({
      sessions: [sessionA],
      links: [expect.objectContaining({ callId: "call-A", upstreamKey: "upstream-A" })],
    });
  });
});

describe("PersistentSessionDocument backward compatibility", () => {
  it("T7: migrates v1 sessions-only on the next mutation", async () => {
    await writeFile(file, JSON.stringify({ version: 1, sessions: [sessionA] }));
    const current = await stores();
    expect(await current.sessions.load()).toEqual({ [sessionA.sessionId]: sessionA });
    await current.lineage.record("call-A", "upstream-A");
    expect(await persisted()).toMatchObject({ version: 2, sessions: [sessionA] });
  });

  it("T8: migrates v1 links-only on the next mutation", async () => {
    await writeFile(file, JSON.stringify({
      version: 1,
      links: [{ callId: "call-A", upstreamKey: "upstream-A", createdAt: Date.now() }],
    }));
    const current = await stores();
    await current.sessions.save({ [sessionA.sessionId]: sessionA });
    expect(current.lineage.getUpstreamKey("call-A")).toBe("upstream-A");
    expect(await persisted()).toMatchObject({ version: 2, sessions: [sessionA] });
  });

  it("loads v1 mixed and preserves unknown siblings", async () => {
    await writeFile(file, JSON.stringify({
      version: 1,
      sessions: [sessionA],
      links: [{ callId: "call-A", upstreamKey: "upstream-A", createdAt: Date.now() }],
      futureSibling: { keep: true },
    }));
    const current = await stores();
    await current.sessions.save({
      [sessionA.sessionId]: sessionA,
      [sessionB.sessionId]: sessionB,
    });
    expect(await persisted()).toMatchObject({
      version: 2,
      futureSibling: { keep: true },
      sessions: [sessionA, sessionB],
      links: [expect.objectContaining({ callId: "call-A" })],
    });
  });

  it("reloads a v2 mixed document", async () => {
    await writeFile(file, JSON.stringify({
      version: 2,
      sessions: [sessionA],
      links: [{ callId: "call-A", upstreamKey: "upstream-A", createdAt: Date.now() }],
    }));
    const current = await stores();
    expect(await current.sessions.load()).toEqual({ [sessionA.sessionId]: sessionA });
    expect(current.lineage.getUpstreamKey("call-A")).toBe("upstream-A");
  });

  it("fails closed for an unknown future version without changing the file", async () => {
    const original = JSON.stringify({ version: 99, sessions: [sessionA], links: [] });
    await writeFile(file, original);
    const document = new PersistentSessionDocument(file);
    await expect(document.init()).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("fails closed for invalid JSON without treating it as empty", async () => {
    const original = "{ truncated";
    await writeFile(file, original);
    const document = new PersistentSessionDocument(file);
    await expect(document.init()).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    expect(await readFile(file, "utf8")).toBe(original);
  });
});

describe("PersistentSessionDocument sibling-safe cleanup and durable failures", () => {
  it("T9: lineage clear and remove preserve sessions and unknown siblings", async () => {
    await writeFile(file, JSON.stringify({
      version: 1,
      sessions: [sessionA],
      links: [
        { callId: "remove", upstreamKey: "remove-key", createdAt: Date.now() },
        { callId: "keep", upstreamKey: "keep-key", createdAt: Date.now() },
      ],
      futureSibling: "keep-me",
    }));
    const current = await stores();
    await current.lineage.removeByUpstreamKey("remove-key");
    expect(await persisted()).toMatchObject({
      sessions: [sessionA],
      futureSibling: "keep-me",
      links: [expect.objectContaining({ callId: "keep" })],
    });
    await current.lineage.clear();
    expect(await persisted()).toMatchObject({
      sessions: [sessionA],
      links: [],
      futureSibling: "keep-me",
    });
  });

  it("T9: lineage init prune preserves sessions on the next record", async () => {
    await writeFile(file, JSON.stringify({
      version: 1,
      sessions: [sessionA],
      links: [{ callId: "stale", upstreamKey: "old", createdAt: 1 }],
    }));
    const current = await stores();
    expect(current.lineage.getUpstreamKey("stale")).toBeUndefined();
    await current.lineage.record("fresh", "new");
    expect(await persisted()).toMatchObject({
      sessions: [sessionA],
      links: [expect.objectContaining({ callId: "fresh" })],
    });
  });

  it("T9: session purge preserves lineage", async () => {
    await writeFile(file, JSON.stringify({
      version: 1,
      sessions: [sessionA],
      links: [{ callId: "keep", upstreamKey: "upstream", createdAt: Date.now() }],
    }));
    const document = new PersistentSessionDocument(file);
    await document.init();
    const manager = new SessionManager(new FileSessionStorage(document), { ttlMs: 1 });
    await manager.init();
    expect(await persisted()).toMatchObject({
      sessions: [],
      links: [expect.objectContaining({ callId: "keep" })],
    });
  });

  it("propagates session and lineage commit failures and rolls back memory", async () => {
    const document = new PersistentSessionDocument(file, {
      write: async () => { throw new Error("synthetic write failure"); },
    });
    await document.init();
    const manager = new SessionManager(new FileSessionStorage(document), { ttlMs: Number.MAX_SAFE_INTEGER });
    const lineage = new LineageStore(document);
    await manager.init();
    await lineage.init();

    await expect(manager.addSession("synthetic-cookie")).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    await expect(lineage.record("call-failed", "upstream-failed")).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    expect(manager.listSessions()).toEqual([]);
    expect(lineage.getUpstreamKey("call-failed")).toBeUndefined();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("propagates remove/touch/lineage cleanup failures without changing committed state", async () => {
    let failWrites = false;
    const document = new PersistentSessionDocument(file, {
      write: async (target, data, mode) => {
        if (failWrites) throw new Error("synthetic write failure");
        await writeJsonAtomic(target, data, mode);
      },
    });
    await document.init();
    const manager = new SessionManager(new FileSessionStorage(document), { ttlMs: Number.MAX_SAFE_INTEGER });
    const lineage = new LineageStore(document);
    await manager.init();
    await lineage.init();
    const session = await manager.addSession("synthetic-cookie");
    await lineage.record("call-A", "upstream-A");
    const committed = await readFile(file, "utf8");
    failWrites = true;

    await expect(manager.touch(session.sessionId)).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    await expect(manager.removeSession(session.sessionId)).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    await expect(lineage.removeByUpstreamKey("upstream-A")).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    await expect(lineage.clear()).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });

    expect(manager.getSession(session.sessionId)).not.toBeNull();
    expect(lineage.getUpstreamKey("call-A")).toBe("upstream-A");
    expect(await readFile(file, "utf8")).toBe(committed);
  });
});
