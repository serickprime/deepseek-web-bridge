import { describe, expect, it, beforeEach } from "vitest";
import { parseUpdateChunk, isTerminalUpdate, resetFragmentState } from "../../src/deepseek/updateParser.js";
import { SseAccumulator, parseSseBlock } from "../../src/deepseek/sseParser.js";
import { anthropicSseMessageDone } from "../../src/server/outputAnthropic.js";
import { ProtocolStream } from "../../src/server/protocolStream.js";

describe("updateParser", () => {
  it("parses a streaming content chunk", () => {
    const chunk = parseUpdateChunk({
      data: {
        type: "response_message",
        index: 0,
        message: { content: "Hello", new_parent_message_id: "parent-1" },
        message_id: "msg-1",
      },
    });
    expect(chunk).not.toBeNull();
    expect(chunk?.delta).toBe("Hello");
    expect(chunk?.messageId).toBe("msg-1");
    expect(chunk?.done).toBe(false);
  });

  it("parses reasoning content", () => {
    const chunk = parseUpdateChunk({
      data: {
        type: "response_message",
        index: 0,
        message: { content: "" },
        reasoning_content: "thinking...",
        message_id: "msg-2",
      },
    });
    expect(chunk?.reasoningDelta).toBe("thinking...");
  });

  it("parses terminal update with usage", () => {
    const chunk = parseUpdateChunk({
      data: {
        type: "response_message_done",
        index: 0,
        message_id: "msg-3",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          prompt_cache_hit_tokens: 4,
        },
      },
    });
    expect(chunk?.done).toBe(true);
    expect(chunk?.usage?.promptTokens).toBe(14);
    expect(chunk?.usage?.completionTokens).toBe(5);
  });

  it("isTerminalUpdate detects done", () => {
    expect(isTerminalUpdate({ data: { type: "response_message_done" } })).toBe(true);
    expect(isTerminalUpdate({ data: { type: "response_message" } })).toBe(false);
  });
});

describe("THINK/RESPONSE fragment routing (new p/o/v format)", () => {
  beforeEach(() => { resetFragmentState(); });

  it("THINK fragment → reasoningDelta, NOT delta", () => {
    const chunk = parseUpdateChunk({
      v: { response: { fragments: [{ type: "THINK", content: "reasoning text" }] } },
    });
    expect(chunk?.delta).toBe("");
    expect(chunk?.reasoningDelta).toBe("reasoning text");
  });

  it("RESPONSE fragment → delta, NOT reasoningDelta", () => {
    const chunk = parseUpdateChunk({
      v: { response: { fragments: [{ type: "RESPONSE", content: "visible text" }] } },
    });
    expect(chunk?.delta).toBe("visible text");
    expect(chunk?.reasoningDelta).toBeUndefined();
  });

  it("THINK → RESPONSE switches state correctly", () => {
    const c1 = parseUpdateChunk({
      v: { response: { fragments: [{ type: "THINK", content: "thinking" }] } },
    });
    expect(c1?.reasoningDelta).toBe("thinking");
    expect(c1?.delta).toBe("");

    const c2 = parseUpdateChunk({
      v: { response: { fragments: [{ type: "RESPONSE", content: "answer" }] } },
    });
    expect(c2?.delta).toBe("answer");
    expect(c2?.reasoningDelta).toBeUndefined();
  });

  it("APPEND after THINK goes to reasoningDelta", () => {
    parseUpdateChunk({
      v: { response: { fragments: [{ type: "THINK", content: "initial" }] } },
    });
    const chunk = parseUpdateChunk({
      v: { p: "response/fragments/-1/content", o: "APPEND", v: " continued" },
    });
    expect(chunk?.reasoningDelta).toBe(" continued");
    expect(chunk?.delta).toBe("");
  });

  it("APPEND after RESPONSE goes to delta", () => {
    parseUpdateChunk({
      v: { response: { fragments: [{ type: "RESPONSE", content: "initial" }] } },
    });
    const chunk = parseUpdateChunk({
      v: { p: "response/fragments/-1/content", o: "APPEND", v: " more" },
    });
    expect(chunk?.delta).toBe(" more");
    expect(chunk?.reasoningDelta).toBeUndefined();
  });

  it("FINISHED resets fragment state", () => {
    parseUpdateChunk({
      v: { response: { fragments: [{ type: "THINK", content: "thought" }] } },
    });
    parseUpdateChunk({ v: { p: "response/status", o: "SET", v: "FINISHED" } });
    const chunk = parseUpdateChunk({
      v: { response: { fragments: [{ type: "RESPONSE", content: "new answer" }] } },
    });
    expect(chunk?.delta).toBe("new answer");
    expect(chunk?.reasoningDelta).toBeUndefined();
  });

  it("fragment without type uses last known state", () => {
    parseUpdateChunk({
      v: { response: { fragments: [{ type: "THINK", content: "thinking" }] } },
    });
    const chunk = parseUpdateChunk({
      v: { response: { fragments: [{ content: "more thinking" }] } },
    });
    expect(chunk?.reasoningDelta).toBe("more thinking");
    expect(chunk?.delta).toBe("");
  });

  it("old format reasoning_content still works", () => {
    const chunk = parseUpdateChunk({
      data: { type: "response_message", index: 0, message: { content: "" }, reasoning_content: "old reasoning" },
    });
    expect(chunk?.reasoningDelta).toBe("old reasoning");
    expect(chunk?.delta).toBe("");
  });
});

describe("anthropic stop_reason", () => {
  it("text response → end_turn", () => {
    const chunks: string[] = [];
    const stream = new ProtocolStream("anthropic", "test", c => chunks.push(c));
    stream.push({ type: "content", text: "hello" });
    stream.finish();
    const msgDelta = chunks.find(c => c.includes("message_delta"));
    expect(msgDelta).toContain('"stop_reason":"end_turn"');
  });

  it("tool_use response → tool_use", () => {
    const chunks: string[] = [];
    const stream = new ProtocolStream("anthropic", "test", c => chunks.push(c));
    stream.push({ type: "tool_use", toolCall: { id: "call_1", type: "function", name: "Grep", arguments: {} } });
    stream.finish();
    const msgDelta = chunks.find(c => c.includes("message_delta"));
    expect(msgDelta).toContain('"stop_reason":"tool_use"');
  });
});

describe("sseParser", () => {
  it("parses a single SSE block", () => {
    const event = parseSseBlock('event: update\ndata: {"data":{"type":"response_message"}}');
    expect(event?.type).toBe("update");
    expect(event?.data).toEqual({ data: { type: "response_message" } });
  });

  it("accumulates partial chunks", () => {
    const acc = new SseAccumulator();
    const first = acc.push(Buffer.from('event: update\ndata: {"da'));
    expect(first).toEqual([]);
    const second = acc.push(Buffer.from('ta":{"type":"response_message"}}\n\n'));
    expect(second).toHaveLength(1);
    expect(second[0]?.type).toBe("update");
  });
});
