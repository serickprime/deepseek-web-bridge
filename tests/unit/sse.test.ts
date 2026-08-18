import { describe, expect, it } from "vitest";
import { parseUpdateChunk, isTerminalUpdate } from "../../src/deepseek/updateParser.js";
import { SseAccumulator, parseSseBlock } from "../../src/deepseek/sseParser.js";

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
