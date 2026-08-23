import { randomToken } from "../utils/crypto.js";
import {
  type PersistentSessionLink,
  PersistentSessionDocument,
} from "./persistentSessionDocument.js";

export type SessionLink = PersistentSessionLink;

export class LineageStore {
  private links = new Map<string, SessionLink>();

  constructor(private readonly document: PersistentSessionDocument) {}

  async init(): Promise<void> {
    this.links.clear();
    for (const item of this.document.getLinks()) this.links.set(item.callId, item);
    const now = Date.now();
    for (const [callId, link] of this.links) {
      if (now - link.createdAt > 24 * 60 * 60 * 1000) this.links.delete(callId);
    }
  }

  getUpstreamKey(callId: string): string | undefined {
    return this.links.get(callId)?.upstreamKey;
  }

  async record(callId: string, upstreamKey: string): Promise<void> {
    const previous = new Map(this.links);
    if (this.links.size > 10_000) {
      const now = Date.now();
      for (const [key, link] of this.links) {
        if (now - link.createdAt > 24 * 60 * 60 * 1000) this.links.delete(key);
      }
    }
    this.links.set(callId, { callId, upstreamKey, createdAt: Date.now() });
    try {
      await this.persist();
    } catch (error) {
      this.links = previous;
      throw error;
    }
  }

  async removeByUpstreamKey(upstreamKey: string): Promise<void> {
    const removed: SessionLink[] = [];
    for (const [callId, link] of this.links) {
      if (link.upstreamKey === upstreamKey) {
        this.links.delete(callId);
        removed.push(link);
      }
    }
    if (removed.length === 0) return;
    try {
      await this.persist();
    } catch (error) {
      for (const link of removed) this.links.set(link.callId, link);
      throw error;
    }
  }

  async clear(): Promise<void> {
    const previous = new Map(this.links);
    this.links.clear();
    try {
      await this.persist();
    } catch (error) {
      this.links = previous;
      throw error;
    }
  }

  private async persist(): Promise<void> {
    await this.document.replaceLinks([...this.links.values()]);
  }
}

export function generateUpstreamKey(): string {
  return randomToken(16);
}
