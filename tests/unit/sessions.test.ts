import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../src/auth/sessionManager.js";
import { generateSessionId } from "../../src/auth/session.js";
import type { SessionMap } from "../../src/auth/session.js";
import type { SessionStorage } from "../../src/auth/storage.js";
import { SessionStore } from "../../src/sessions/sessionStore.js";
import { KeyedMutex } from "../../src/sessions/mutex.js";
import { LineageStore } from "../../src/sessions/lineage.js";
import { extractToolUseIdFromMessages } from "../../src/api/handler.js";
import { SESSION_ID_ENTROPY_BYTES } from "../../src/config/constants.js";
import type { CanonicalRequest } from "../../src/api/canonical.js";
import { resetUpstreamAccountState } from "../../src/app.js";

class MemoryStorage implements SessionStorage {
  private map: SessionMap = {};
  async load(): Promise<SessionMap> {
    return JSON.parse(JSON.stringify(this.map));
  }
  async save(map: SessionMap): Promise<void> {
    this.map = JSON.parse(JSON.stringify(map));
  }
}

describe("SessionManager", () => {
  it("creates, lists and removes sessions", async () => {
    const manager = new SessionManager(new MemoryStorage(), { ttlMs: 60_000 });
    await manager.init();
    const session = await manager.addSession("cookie=abc123;", "main");
    expect(session.sessionId).toHaveLength(32);
    expect(manager.getSession(session.sessionId)).not.toBeNull();
    expect(manager.listSessions()).toHaveLength(1);
    await manager.removeSession(session.sessionId);
    expect(manager.listSessions()).toHaveLength(0);
  });

  it("expires stale sessions", async () => {
    const manager = new SessionManager(new MemoryStorage(), { ttlMs: -1 });
    await manager.init();
    const session = await manager.addSession("cookie=abc;");
    expect(manager.getSession(session.sessionId)).toBeNull();
  });

  it("persists and reloads", async () => {
    const storage = new MemoryStorage();
    const first = new SessionManager(storage, { ttlMs: 60_000 });
    await first.init();
    const session = await first.addSession("cookie=x;");
    const second = new SessionManager(storage, { ttlMs: 60_000 });
    await second.init();
    expect(second.getSession(session.sessionId)).not.toBeNull();
  });
});

describe("generateSessionId", () => {
  it("SESSION_ID_ENTROPY_BYTES is 16", () => {
    expect(SESSION_ID_ENTROPY_BYTES).toBe(16);
  });

  it("produces 32-character hex string from 16 random bytes", () => {
    const id = generateSessionId();
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("produces unique IDs on successive calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSessionId()));
    expect(ids.size).toBe(100);
  });
});

describe("SessionStore", () => {
  it("enforces history limits", () => {
    const store = new SessionStore(2, 20);
    const state = store.getOrCreate("key");
    store.appendHistory(state, { role: "user", content: "a".repeat(10) });
    store.appendHistory(state, { role: "user", content: "b".repeat(10) });
    store.appendHistory(state, { role: "user", content: "c".repeat(10) });
    expect(state.history.length).toBeLessThanOrEqual(2);
    let total = 0;
    for (const entry of state.history) total += entry.content.length;
    expect(total).toBeLessThanOrEqual(20);
  });
});

describe("KeyedMutex", () => {
  it("serializes tasks under same key", async () => {
    const mutex = new KeyedMutex();
    const order: number[] = [];
    await Promise.all([
      mutex.withLock("a", async () => {
        await new Promise(r => setTimeout(r, 20));
        order.push(1);
      }),
      mutex.withLock("a", async () => {
        order.push(2);
      }),
    ]);
    expect(order).toEqual([1, 2]);
  });

  it("runs different keys in parallel", async () => {
    const mutex = new KeyedMutex();
    let done = 0;
    const tasks = ["a", "b"].map(key =>
      mutex.withLock(key, async () => {
        await new Promise(r => setTimeout(r, 10));
        done++;
      }),
    );
    await Promise.all(tasks);
    expect(done).toBe(2);
  });
});

describe("LineageStore", () => {
  it("records and retrieves call_id to upstream mapping", async () => {
    const lineage = new LineageStore(":memory:");
    await lineage.record("call_ABC", "upstream:123");
    expect(lineage.getUpstreamKey("call_ABC")).toBe("upstream:123");
  });

  it("returns undefined for unknown call_id", async () => {
    const lineage = new LineageStore(":memory:");
    expect(lineage.getUpstreamKey("unknown")).toBeUndefined();
  });

  it("clears old upstream state and lineage during an account swap", async () => {
    const sessions = new SessionStore();
    const state = sessions.getOrCreate("old-account-session");
    state.chatSessionId = "old-deepseek-chat";
    state.parentMessageId = 123;
    const lineage = new LineageStore(":memory:");
    await lineage.record("old-call", "old-account-session");

    await resetUpstreamAccountState(sessions, lineage);

    expect(sessions.get("old-account-session")).toBeUndefined();
    expect(lineage.getUpstreamKey("old-call")).toBeUndefined();
  });

  it("clears persisted lineage without deleting sessions.json sibling data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-lineage-clear-"));
    const file = join(dir, "sessions.json");
    const savedSession = {
      sessionId: "local-session",
      sidCookie: "local-cookie",
      createdAt: 1,
      updatedAt: 1,
    };
    await writeFile(file, JSON.stringify({
      version: 1,
      sessions: [savedSession],
      links: [{ callId: "old-call", upstreamKey: "old-upstream", createdAt: Date.now() }],
    }));

    try {
      const lineage = new LineageStore(file);
      await lineage.init();
      await lineage.clear();
      const persisted = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;

      expect(persisted.sessions).toEqual([savedSession]);
      expect(persisted.links).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("extractToolUseIdFromMessages", () => {
  it("extracts tool_use_id from tool_result block", () => {
    const request: CanonicalRequest = {
      model: "test",
      stream: false,
      system: "",
      messages: [{
        role: "user",
        parts: [{
          type: "tool_result",
          toolResult: { toolUseId: "call_ABC", content: "file contents" },
        }],
      }],
      tools: [],
    };
    expect(extractToolUseIdFromMessages(request)).toBe("call_ABC");
  });

  it("returns undefined when no tool_result present", () => {
    const request: CanonicalRequest = {
      model: "test",
      stream: false,
      system: "",
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
      tools: [],
    };
    expect(extractToolUseIdFromMessages(request)).toBeUndefined();
  });

  it("returns undefined for empty messages", () => {
    const request: CanonicalRequest = {
      model: "test",
      stream: false,
      system: "",
      messages: [],
      tools: [],
    };
    expect(extractToolUseIdFromMessages(request)).toBeUndefined();
  });
});
