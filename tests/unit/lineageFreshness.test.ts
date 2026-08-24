import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompletionHandler, extractToolUseIdFromMessages } from "../../src/api/handler.js";
import type { CanonicalMessage, CanonicalRequest } from "../../src/api/canonical.js";
import { normalizeAnthropic } from "../../src/api/normalizeAnthropic.js";
import { normalizeOpenAI } from "../../src/api/normalizeOpenAI.js";
import { normalizeResponses } from "../../src/api/normalizeResponses.js";
import { SESSION_LINK_TTL_MS } from "../../src/config/constants.js";
import type { DeepSeekClient } from "../../src/deepseek/client.js";
import { LineageStore } from "../../src/sessions/lineage.js";
import { PersistentSessionDocument } from "../../src/sessions/persistentSessionDocument.js";
import { SessionStore } from "../../src/sessions/sessionStore.js";
import type { ProtocolStream } from "../../src/server/protocolStream.js";
import type { Logger } from "../../src/utils/logger.js";

const BASE_NOW = 2_000_000_000_000;
let now = BASE_NOW;

beforeEach(() => {
  now = BASE_NOW;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function memoryLineage(): Promise<{ document: PersistentSessionDocument; lineage: LineageStore }> {
  const document = new PersistentSessionDocument(":memory:");
  await document.init();
  const lineage = new LineageStore(document);
  await lineage.init();
  return { document, lineage };
}

function request(messages: CanonicalMessage[]): CanonicalRequest {
  return {
    model: "deepseek-v4-flash",
    stream: false,
    system: "",
    messages,
    tools: [],
  };
}

function instruction(text = "continue the current task"): CanonicalMessage {
  return { role: "user", parts: [{ type: "text", text }] };
}

function result(id: string): CanonicalMessage {
  return {
    role: "user",
    parts: [{ type: "tool_result", toolResult: { toolUseId: id, content: `${id}-output` } }],
  };
}

function streamStub(): ProtocolStream {
  return {
    start: vi.fn(),
    push: vi.fn(),
    finish: vi.fn(),
    fail: vi.fn(),
  } as unknown as ProtocolStream;
}

async function runHandler(
  lineage: LineageStore,
  canonicalRequest: CanonicalRequest,
  headers: Record<string, string | undefined> = {},
  body: Record<string, unknown> = {},
) {
  const deepseek = {
    getAuthGeneration: () => 0,
    ensureSession: vi.fn(async () => undefined),
    complete: vi.fn(async () => ({ content: "ok", toolCall: null })),
  } as unknown as DeepSeekClient;
  const handler = new CompletionHandler({
    deepseek,
    sessionStore: new SessionStore(),
    lineage,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
  });
  return handler.run({
    protocol: "anthropic",
    request: canonicalRequest,
    headers,
    body,
    stream: streamStub(),
  });
}

describe("D5 lineage TTL and durable pruning", () => {
  it("keeps a link at TTL-1", async () => {
    const { lineage } = await memoryLineage();
    await lineage.record("fresh", "upstream-fresh");
    now += SESSION_LINK_TTL_MS - 1;
    expect(lineage.getUpstreamKey("fresh")).toBe("upstream-fresh");
  });

  it("keeps a link at the exact TTL boundary", async () => {
    const { lineage } = await memoryLineage();
    await lineage.record("boundary", "upstream-boundary");
    now += SESSION_LINK_TTL_MS;
    expect(lineage.getUpstreamKey("boundary")).toBe("upstream-boundary");
  });

  it("rejects and removes a link at TTL+1 during lookup", async () => {
    const { lineage } = await memoryLineage();
    await lineage.record("expired", "upstream-expired");
    now += SESSION_LINK_TTL_MS + 1;
    expect(lineage.getUpstreamKey("expired")).toBeUndefined();
    expect(lineage.getUpstreamKey("expired")).toBeUndefined();
  });

  it("PB31/PB32 prunes expired links durably during restart init", async () => {
    const root = await mkdtemp(join(tmpdir(), "d5-restart-"));
    const file = join(root, "sessions.json");
    await writeFile(file, JSON.stringify({
      version: 2,
      sessions: [],
      links: [
        { callId: "expired", upstreamKey: "old", createdAt: now - SESSION_LINK_TTL_MS - 1 },
        { callId: "fresh", upstreamKey: "current", createdAt: now },
      ],
    }));
    try {
      const document = new PersistentSessionDocument(file);
      await document.init();
      const lineage = new LineageStore(document);
      await lineage.init();
      expect(lineage.getUpstreamKey("expired")).toBeUndefined();
      expect(lineage.getUpstreamKey("fresh")).toBe("current");
      const persisted = JSON.parse(await readFile(file, "utf8")) as { links: Array<{ callId: string }> };
      expect(persisted.links.map(link => link.callId)).toEqual(["fresh"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("durable init pruning preserves sessions and unknown siblings", async () => {
    const root = await mkdtemp(join(tmpdir(), "d5-siblings-"));
    const file = join(root, "sessions.json");
    const session = { sessionId: "session-A", sidCookie: "synthetic", createdAt: 1, updatedAt: 1 };
    await writeFile(file, JSON.stringify({
      version: 2,
      sessions: [session],
      links: [{ callId: "expired", upstreamKey: "old", createdAt: now - SESSION_LINK_TTL_MS - 1 }],
      futureSibling: { keep: true },
    }));
    try {
      const document = new PersistentSessionDocument(file);
      await document.init();
      const lineage = new LineageStore(document);
      await lineage.init();
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
        version: 2,
        sessions: [session],
        links: [],
        futureSibling: { keep: true },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prunes expired siblings on every normal small-store record", async () => {
    const document = new PersistentSessionDocument("virtual", {
      read: async () => ({
        exists: true,
        value: {
          version: 2,
          sessions: [],
          links: [
            { callId: "soon-expired", upstreamKey: "old", createdAt: now - SESSION_LINK_TTL_MS + 1 },
            { callId: "keep", upstreamKey: "keep-upstream", createdAt: now },
          ],
        },
      }),
      write: async () => undefined,
    });
    await document.init();
    const lineage = new LineageStore(document);
    await lineage.init();
    now += 2;
    await lineage.record("new", "new-upstream");
    expect(lineage.getUpstreamKey("soon-expired")).toBeUndefined();
    expect(lineage.getUpstreamKey("keep")).toBe("keep-upstream");
    expect(document.getLinks().map(link => link.callId)).toEqual(["keep", "new"]);
  });

  it("persists lazy lookup cleanup on the next awaited mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "d5-lazy-cleanup-"));
    const file = join(root, "sessions.json");
    await writeFile(file, JSON.stringify({
      version: 2,
      sessions: [],
      links: [{ callId: "expires-later", upstreamKey: "old", createdAt: now }],
    }));
    try {
      const document = new PersistentSessionDocument(file);
      await document.init();
      const lineage = new LineageStore(document);
      await lineage.init();
      now += SESSION_LINK_TTL_MS + 1;
      expect(lineage.getUpstreamKey("expires-later")).toBeUndefined();
      expect((JSON.parse(await readFile(file, "utf8")) as { links: unknown[] }).links).toHaveLength(1);
      await lineage.removeByUpstreamKey("unrelated");
      expect((JSON.parse(await readFile(file, "utf8")) as { links: unknown[] }).links).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when durable init pruning cannot be committed", async () => {
    const document = new PersistentSessionDocument("virtual", {
      read: async () => ({
        exists: true,
        value: {
          version: 2,
          sessions: [],
          links: [{ callId: "expired", upstreamKey: "old", createdAt: now - SESSION_LINK_TTL_MS - 1 }],
        },
      }),
      write: async () => { throw new Error("synthetic init prune failure"); },
    });
    await document.init();
    const lineage = new LineageStore(document);
    await expect(lineage.init()).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    expect(document.getLinks()).toEqual([
      expect.objectContaining({ callId: "expired", upstreamKey: "old" }),
    ]);
  });

  it("rolls memory and document back when prune plus record persistence fails", async () => {
    const document = new PersistentSessionDocument("virtual", {
      read: async () => ({
        exists: true,
        value: {
          version: 2,
          sessions: [],
          links: [
            { callId: "soon-expired", upstreamKey: "old", createdAt: now - SESSION_LINK_TTL_MS + 1 },
            { callId: "keep", upstreamKey: "keep-upstream", createdAt: now },
          ],
        },
      }),
      write: async () => { throw new Error("synthetic record failure"); },
    });
    await document.init();
    const lineage = new LineageStore(document);
    await lineage.init();
    now += 2;
    await expect(lineage.record("new", "new-upstream")).rejects.toMatchObject({ code: "PERSISTENCE_ERROR" });
    expect(lineage.getUpstreamKey("keep")).toBe("keep-upstream");
    expect(lineage.getUpstreamKey("soon-expired")).toBeUndefined();
    expect(lineage.getUpstreamKey("new")).toBeUndefined();
    expect(document.getLinks().map(link => link.callId)).toEqual(["soon-expired", "keep"]);
  });
});

describe("D5 latest current-cycle tool-result selection", () => {
  it("PB32 selects new from current results ordered old,new", () => {
    expect(extractToolUseIdFromMessages(request([instruction(), result("old"), result("new")]))).toBe("new");
  });

  it("ignores a historical result before a newer independent user instruction", () => {
    expect(extractToolUseIdFromMessages(request([
      instruction("old task"),
      result("historical"),
      instruction("new independent task"),
    ]))).toBeUndefined();
  });

  it("selects the latest part among multiple results in the current cycle", () => {
    expect(extractToolUseIdFromMessages(request([
      instruction(),
      {
        role: "user",
        parts: [
          { type: "tool_result", toolResult: { toolUseId: "old", content: "old" } },
          { type: "tool_result", toolResult: { toolUseId: "new", content: "new" } },
        ],
      },
    ]))).toBe("new");
  });

  it("preserves latest-result selection after Anthropic normalization", () => {
    const normalized = normalizeAnthropic({
      model: "deepseek-v4-flash",
      max_tokens: 64,
      messages: [
        { role: "user", content: "do the task" },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "old", content: "old" },
          { type: "tool_result", tool_use_id: "new", content: "new" },
        ] },
      ],
    }, {});
    expect(extractToolUseIdFromMessages(normalized)).toBe("new");
  });

  it("preserves latest-result selection after OpenAI normalization", () => {
    const normalized = normalizeOpenAI({
      model: "deepseek-v4-flash",
      messages: [
        { role: "user", content: "do the task" },
        { role: "tool", tool_call_id: "old", content: "old" },
        { role: "tool", tool_call_id: "new", content: "new" },
      ],
    }, {});
    expect(extractToolUseIdFromMessages(normalized)).toBe("new");
  });

  it("preserves latest-result selection after Responses normalization", () => {
    const normalized = normalizeResponses({
      model: "deepseek-v4-flash",
      input: [
        { role: "user", content: [{ type: "input_text", text: "do the task" }] },
        { role: "user", content: [
          { type: "function_call_output", call_id: "old", output: "old" },
          { type: "function_call_output", call_id: "new", output: "new" },
        ] },
      ],
    }, {});
    expect(extractToolUseIdFromMessages(normalized)).toBe("new");
  });
});

describe("D5 handler lineage resolution", () => {
  it("uses a fresh header mapping when it is the only resolved lineage", async () => {
    const { lineage } = await memoryLineage();
    await lineage.record("header", "upstream-header");
    await expect(runHandler(lineage, request([instruction()]), { "x-call-id": "header" }))
      .resolves.toMatchObject({ upstreamKey: "upstream-header" });
  });

  it("uses a fresh current-cycle result mapping when it is the only resolved lineage", async () => {
    const { lineage } = await memoryLineage();
    await lineage.record("result", "upstream-result");
    await expect(runHandler(lineage, request([instruction(), result("result")])))
      .resolves.toMatchObject({ upstreamKey: "upstream-result" });
  });

  it("accepts header and current result when both resolve to the same upstream", async () => {
    const { lineage } = await memoryLineage();
    await lineage.record("header", "upstream-shared");
    await lineage.record("result", "upstream-shared");
    await expect(runHandler(
      lineage,
      request([instruction(), result("result")]),
      { "x-call-id": "header" },
    )).resolves.toMatchObject({ upstreamKey: "upstream-shared" });
  });

  it("throws SESSION_CONFLICT when header and current result resolve differently", async () => {
    const { lineage } = await memoryLineage();
    await lineage.record("header", "upstream-header");
    await lineage.record("result", "upstream-result");
    await expect(runHandler(
      lineage,
      request([instruction(), result("result")]),
      { "x-call-id": "header" },
    )).rejects.toMatchObject({ code: "SESSION_CONFLICT", status: 409 });
  });

  it("falls back from an unknown header to the current result", async () => {
    const { lineage } = await memoryLineage();
    await lineage.record("result", "upstream-result");
    await expect(runHandler(
      lineage,
      request([instruction(), result("result")]),
      { "x-call-id": "unknown" },
    )).resolves.toMatchObject({ upstreamKey: "upstream-result" });
  });

  it("falls back from an expired header to a fresh current result", async () => {
    const { lineage } = await memoryLineage();
    await lineage.record("header", "upstream-header");
    now += SESSION_LINK_TTL_MS + 1;
    await lineage.record("result", "upstream-result");
    await expect(runHandler(
      lineage,
      request([instruction(), result("result")]),
      { "x-call-id": "header" },
    )).resolves.toMatchObject({ upstreamKey: "upstream-result" });
  });

  it("keeps explicit body upstream precedence without evaluating conflicting lineage", async () => {
    const { lineage } = await memoryLineage();
    await lineage.record("header", "upstream-header");
    await lineage.record("result", "upstream-result");
    await expect(runHandler(
      lineage,
      request([instruction(), result("result")]),
      { "x-call-id": "header" },
      { user: "explicit-upstream" },
    )).resolves.toMatchObject({ upstreamKey: "explicit-upstream" });
  });
});
