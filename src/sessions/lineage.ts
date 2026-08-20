import { readJsonIfExists, writeJsonAtomic } from "../utils/atomicFile.js";
import { isRecord } from "../utils/json.js";
import { randomToken } from "../utils/crypto.js";

export interface SessionLink {
  callId: string;
  upstreamKey: string;
  createdAt: number;
}

const LINK_VERSION = 1;

interface LinkFileShape {
  version: number;
  links: SessionLink[];
}

function isLink(value: unknown): value is SessionLink {
  return (
    isRecord(value) &&
    typeof value.callId === "string" &&
    typeof value.upstreamKey === "string" &&
    typeof value.createdAt === "number"
  );
}

export class LineageStore {
  private readonly file: string;
  private links = new Map<string, SessionLink>();

  constructor(file: string) {
    this.file = file;
  }

  async init(): Promise<void> {
    const raw = await readJsonIfExists(this.file);
    if (!isRecord(raw) || !Array.isArray(raw.links)) return;
    for (const item of raw.links) {
      if (isLink(item)) this.links.set(item.callId, item);
    }
    const now = Date.now();
    for (const [callId, link] of this.links) {
      if (now - link.createdAt > 24 * 60 * 60 * 1000) this.links.delete(callId);
    }
  }

  getUpstreamKey(callId: string): string | undefined {
    return this.links.get(callId)?.upstreamKey;
  }

  async record(callId: string, upstreamKey: string): Promise<void> {
    if (this.links.size > 10_000) {
      const now = Date.now();
      for (const [key, link] of this.links) {
        if (now - link.createdAt > 24 * 60 * 60 * 1000) this.links.delete(key);
      }
    }
    this.links.set(callId, { callId, upstreamKey, createdAt: Date.now() });
    await this.persist();
  }

  async removeByUpstreamKey(upstreamKey: string): Promise<void> {
    let changed = false;
    for (const [callId, link] of this.links) {
      if (link.upstreamKey === upstreamKey) {
        this.links.delete(callId);
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  async clear(): Promise<void> {
    this.links.clear();
    if (this.file === ":memory:") return;

    const raw = await readJsonIfExists(this.file);
    if (!isRecord(raw) || !Array.isArray(raw.links)) return;
    await writeJsonAtomic(this.file, { ...raw, links: [] }, 0o600).catch(() => undefined);
  }

  private async persist(): Promise<void> {
    const payload: LinkFileShape = {
      version: LINK_VERSION,
      links: [...this.links.values()],
    };
    await writeJsonAtomic(this.file, payload, 0o600).catch(() => undefined);
  }
}

export function generateUpstreamKey(): string {
  return randomToken(16);
}
