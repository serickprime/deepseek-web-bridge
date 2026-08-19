import { isRecord } from "../utils/json.js";

export interface UpdateChunk {
  index: number;
  delta: string;
  reasoningDelta?: string;
  messageId?: string;
  done: boolean;
  parentMessageId?: string | null;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

/* ── DeepSeek Patch State Machine ── */

interface Fragment {
  type: string;
  content: string;
}

export class DeepSeekPatchParser {
  private currentPath: string | undefined;
  private currentOp = "SET";
  private fragments: Fragment[] = [];
  private status: string | undefined;

  apply(raw: unknown): UpdateChunk | null {
    if (!isRecord(raw)) return null;

    // ── Old format: { data: { type: "...", message: {...} } } ──
    if ("data" in raw) return this.applyOldData(raw.data);

    if (!("v" in raw)) return null;
    const v = raw.v;

    // ── New p/o/v format ──
    // Track whether this event explicitly provides path context
    const hasOwnP = typeof raw.p === "string";
    const hasOwnO = typeof raw.o === "string";

    if (hasOwnP) this.currentPath = raw.p as string;
    if (hasOwnO) this.currentOp = raw.o as string;

    let path = this.currentPath;
    let op = this.currentOp;

    // When p/o are nested inside v, extract the actual value
    let value: unknown = v;
    let hasNestedPath = false;
    if (isRecord(v)) {
      if (typeof v.p === "string") { path = v.p; this.currentPath = v.p; hasNestedPath = true; }
      if (typeof v.o === "string") { op = v.o; this.currentOp = v.o; hasNestedPath = true; }
      if ("v" in v) value = v.v;
    }

    const hasPathContext = hasOwnP || hasOwnO || hasNestedPath;

    // Status update: { p: "response/status", o: "SET", v: "FINISHED" }
    if (path === "response/status" && typeof value === "string") {
      this.status = value;
      this.currentPath = undefined;
      this.currentOp = "SET";
      if (value === "FINISHED" || value === "INCOMPLETE") {
        return { index: 0, delta: "", done: true, parentMessageId: null };
      }
      return null;
    }

    // Initial snapshot: { v: { response: { fragments: [...], status: "..." } } }
    if (!path && isRecord(v)) {
      const response = v.response;
      if (isRecord(response)) return this.applyInitialSnapshot(response);
    }

    // BATCH: { v: [...] }
    if (op === "BATCH" && Array.isArray(value)) {
      return this.applyBatch(value);
    }

    // Fragment content append: { p: "response/fragments/-1/content", o: "APPEND", v: "text" }
    if (hasPathContext && path === "response/fragments/-1/content" && op === "APPEND" && typeof value === "string") {
      return this.applyFragmentAppend(value);
    }

    // New fragment append: { p: "response/fragments", o: "APPEND", v: [{type,content}] }
    if (hasPathContext && path === "response/fragments" && op === "APPEND" && Array.isArray(value)) {
      return this.applyNewFragments(value);
    }

    // Plain token delta: { v: "text" } — only when no path context
    if (!path && typeof value === "string") {
      return { index: 0, delta: value, done: false, parentMessageId: null };
    }

    return null;
  }

  private applyInitialSnapshot(response: Record<string, unknown>): UpdateChunk {
    if (typeof response.status === "string") this.status = response.status;

    const fragArr = response.fragments;
    if (Array.isArray(fragArr)) {
      this.fragments = [];
      let delta = "";
      let reasoningDelta = "";
      for (const frag of fragArr) {
        if (!isRecord(frag) || typeof frag.type !== "string" || typeof frag.content !== "string") continue;
        this.fragments.push({ type: frag.type, content: frag.content });
        if (!frag.content) continue;
        if (frag.type === "THINK") reasoningDelta += frag.content;
        else delta += frag.content;
      }
      const messageId = typeof response.message_id === "number" ? String(response.message_id) : undefined;
      const done = this.status === "FINISHED" || this.status === "INCOMPLETE";
      return {
        index: 0,
        delta,
        reasoningDelta: reasoningDelta || undefined,
        messageId,
        done,
        parentMessageId: null,
      };
    }

    return { index: 0, delta: "", done: false, parentMessageId: null };
  }

  private applyBatch(arr: unknown[]): UpdateChunk | null {
    let delta = "";
    let reasoningDelta = "";
    let done = false;
    let messageId: string | undefined;

    const savedPath = this.currentPath;
    const savedOp = this.currentOp;

    let subPath = "";
    let subOp = "SET";

    for (const item of arr) {
      if (!isRecord(item)) continue;
      if (typeof item.p === "string") subPath = item.p;
      if (typeof item.o === "string") subOp = item.o;

      const fullPath = savedPath ? (subPath || savedPath) : subPath;

      this.currentPath = fullPath;
      this.currentOp = subOp;

      if ("v" in item) {
        const child = this.apply({ p: fullPath, o: subOp, v: item.v });
        if (child) {
          delta += child.delta;
          if (child.reasoningDelta) reasoningDelta += child.reasoningDelta;
          if (child.done) done = true;
          if (child.messageId) messageId = child.messageId;
        }
      }
    }

    this.currentPath = savedPath;
    this.currentOp = savedOp;

    if (!delta && !reasoningDelta && !done) return null;

    return {
      index: 0,
      delta,
      reasoningDelta: reasoningDelta || undefined,
      messageId,
      done,
      parentMessageId: null,
    };
  }

  private applyFragmentAppend(text: string): UpdateChunk | null {
    const last = this.fragments[this.fragments.length - 1];
    if (!last) return null;

    last.content += text;

    if (last.type === "THINK") {
      return { index: 0, delta: "", reasoningDelta: text, done: false, parentMessageId: null };
    }
    return { index: 0, delta: text, done: false, parentMessageId: null };
  }

  private applyNewFragments(arr: unknown[]): UpdateChunk | null {
    let delta = "";
    let reasoningDelta = "";

    for (const item of arr) {
      if (!isRecord(item) || typeof item.type !== "string" || typeof item.content !== "string") continue;
      this.fragments.push({ type: item.type, content: item.content });
      if (!item.content) continue;
      if (item.type === "THINK") reasoningDelta += item.content;
      else delta += item.content;
    }

    if (!delta && !reasoningDelta) return null;

    return {
      index: 0,
      delta,
      reasoningDelta: reasoningDelta || undefined,
      done: false,
      parentMessageId: null,
    };
  }

  private applyOldData(data: unknown): UpdateChunk | null {
    if (!isRecord(data)) return null;
    const type = data.type;
    if (typeof type !== "string") return null;

    const message = isRecord(data.message) ? data.message : null;
    const index = typeof data.index === "number" ? data.index : 0;
    const done = type === "response_message_done";
    const messageId = typeof data.message_id === "string" ? data.message_id : undefined;
    const reasoningDelta = typeof data.reasoning_content === "string" ? data.reasoning_content : undefined;

    let delta = "";
    let parentMessageId: string | null = null;
    if (message) {
      if (typeof message.content === "string") {
        delta = message.content;
      } else if (Array.isArray(message.content)) {
        delta = message.content
          .map((part: unknown) => {
            if (isRecord(part) && typeof part.text === "string") return part.text;
            if (typeof part === "string") return part;
            return "";
          })
          .join("");
      }
      const parent = message.new_parent_message_id;
      if (typeof parent === "string") parentMessageId = parent;
    }

    let usage: UpdateChunk["usage"];
    if (isRecord(data.usage)) {
      const u = data.usage;
      const promptTokens = typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined;
      const completionTokens = typeof u.completion_tokens === "number" ? u.completion_tokens : undefined;
      const promptCache = typeof u.prompt_cache_hit_tokens === "number" ? u.prompt_cache_hit_tokens : 0;
      const totalTokens =
        typeof u.total_tokens === "number" ? u.total_tokens
        : promptTokens !== undefined || completionTokens !== undefined
          ? (promptTokens ?? 0) + (completionTokens ?? 0)
          : undefined;
      usage = {
        promptTokens: promptTokens !== undefined ? promptTokens + (promptCache ?? 0) : undefined,
        completionTokens,
        totalTokens,
      };
    }

    return {
      index,
      delta,
      reasoningDelta,
      messageId,
      done,
      parentMessageId: done ? parentMessageId : null,
      usage,
    };
  }

  getStatus(): string | undefined {
    return this.status;
  }

  getFragments(): Fragment[] {
    return this.fragments;
  }
}


