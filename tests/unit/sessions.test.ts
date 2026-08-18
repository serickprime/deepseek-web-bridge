import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/auth/sessionManager.js";
import type { SessionMap } from "../../src/auth/session.js";
import type { SessionStorage } from "../../src/auth/storage.js";
import { SessionStore } from "../../src/sessions/sessionStore.js";
import { KeyedMutex } from "../../src/sessions/mutex.js";

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
