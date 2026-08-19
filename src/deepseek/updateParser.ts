import { isRecord } from "../utils/json.js";

export interface UpdateMessage {
  content: string;
  reasoning?: string;
  parentMessageId: string | null;
}

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

type FragmentType = "THINK" | "RESPONSE";

/** Minimal state: tracks current fragment type for new p/o/v format. */
const fragmentState = { currentType: undefined as FragmentType | undefined };

export function resetFragmentState(): void {
  fragmentState.currentType = undefined;
}

function extractMessage(update: Record<string, unknown>): Record<string, unknown> | null {
  const message = update.message;
  if (isRecord(message)) return message;
  return null;
}

function extractContent(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map(part => {
        if (isRecord(part) && typeof part.text === "string") return part.text;
        if (typeof part === "string") return part;
        return "";
      })
      .join("");
  }
  return "";
}

export function parseUpdateChunk(raw: unknown): UpdateChunk | null {
  if (!isRecord(raw)) return null;

  // New format: { v: ... }
  const v = raw.v;

  // Status update: { p: "response/status", o: "SET", v: "FINISHED" } — check BEFORE string v
  if (typeof raw.p === "string" && raw.p === "response/status" && v === "FINISHED") {
    fragmentState.currentType = undefined;
    return { index: 0, delta: "", done: true, parentMessageId: null };
  }

  // Plain token delta: { v: "text" } — v is a string
  if (typeof v === "string") {
    return { index: 0, delta: v, done: false, parentMessageId: null };
  }

  if (isRecord(v)) {
    const response = v.response;
    if (isRecord(response)) {
      const fragments = response.fragments;
      if (Array.isArray(fragments)) {
        let delta = "";
        let reasoningDelta = "";
        for (const frag of fragments) {
          if (!isRecord(frag) || typeof frag.content !== "string") continue;
          const fragType = typeof frag.type === "string" ? (frag.type as FragmentType) : undefined;
          if (fragType) fragmentState.currentType = fragType;
          if (fragType === "THINK" || fragmentState.currentType === "THINK") {
            reasoningDelta += frag.content;
          } else {
            delta += frag.content;
          }
        }
        const messageId = typeof response.message_id === "number" ? String(response.message_id) : undefined;
        const done = typeof response.status === "string" && response.status === "FINISHED";
        if (done) fragmentState.currentType = undefined;
        return {
          index: 0,
          delta,
          reasoningDelta: reasoningDelta || undefined,
          messageId,
          done,
          parentMessageId: null,
        };
      }
    }
    // Batch update: { p: "response", o: "BATCH", v: [...] }
    // Status update: { p: "response/status", o: "SET", v: "FINISHED" }
    const p = v.p;
    if (p === "response/status" && v.v === "FINISHED") {
      fragmentState.currentType = undefined;
      return { index: 0, delta: "", done: true, parentMessageId: null };
    }
    // Fragment content append: { p: "response/fragments/-1/content", o: "APPEND", v: "text" }
    if (typeof p === "string" && p.includes("fragments") && v.o === "APPEND" && typeof v.v === "string") {
      const text = v.v;
      if (fragmentState.currentType === "THINK") {
        return { index: 0, delta: "", reasoningDelta: text, done: false, parentMessageId: null };
      }
      return { index: 0, delta: text, done: false, parentMessageId: null };
    }
    // Nested token delta: { v: "text" } where v is nested inside a record
    if (typeof v.v === "string" && v.v !== "FINISHED") {
      return { index: 0, delta: v.v, done: false, parentMessageId: null };
    }
  }

  // Old format: { data: { type: "...", message: { content: "..." } } }
  const data = raw.data;
  if (!isRecord(data)) return null;
  const type = data.type;
  if (typeof type !== "string") return null;

  const message = extractMessage(data);
  const index = typeof data.index === "number" ? data.index : 0;
  const done = type === "response_message_done";
  const messageId = typeof data.message_id === "string" ? data.message_id : undefined;
  const reasoningDelta =
    typeof data.reasoning_content === "string" ? data.reasoning_content : undefined;

  let delta = "";
  let parentMessageId: string | null = null;
  if (message) {
    delta = extractContent(message);
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

export function isTerminalUpdate(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const data = raw.data;
  return isRecord(data) && data.type === "response_message_done";
}
