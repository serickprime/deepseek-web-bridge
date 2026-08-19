import { describe, expect, it } from "vitest";
import { DeepSeekPatchParser } from "../../src/deepseek/updateParser.js";
import { SseAccumulator, parseSseBlock } from "../../src/deepseek/sseParser.js";
import { anthropicSseMessageDone } from "../../src/server/outputAnthropic.js";
import { ProtocolStream } from "../../src/server/protocolStream.js";

describe("updateParser", () => {
  it("parses a streaming content chunk (old format)", () => {
    const p = new DeepSeekPatchParser();
    const chunk = p.apply({
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

  it("parses reasoning content (old format)", () => {
    const p = new DeepSeekPatchParser();
    const chunk = p.apply({
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

  it("parses terminal update with usage (old format)", () => {
    const p = new DeepSeekPatchParser();
    const chunk = p.apply({
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
});

describe("THINK/RESPONSE fragment routing (new p/o/v format)", () => {
  it("THINK fragment → reasoningDelta, NOT delta", () => {
    const p = new DeepSeekPatchParser();
    const chunk = p.apply({
      v: { response: { fragments: [{ type: "THINK", content: "reasoning text" }] } },
    });
    expect(chunk?.delta).toBe("");
    expect(chunk?.reasoningDelta).toBe("reasoning text");
  });

  it("RESPONSE fragment → delta, NOT reasoningDelta", () => {
    const p = new DeepSeekPatchParser();
    const chunk = p.apply({
      v: { response: { fragments: [{ type: "RESPONSE", content: "visible text" }] } },
    });
    expect(chunk?.delta).toBe("visible text");
    expect(chunk?.reasoningDelta).toBeUndefined();
  });

  it("THINK → RESPONSE switches state correctly", () => {
    const p = new DeepSeekPatchParser();
    const c1 = p.apply({
      v: { response: { fragments: [{ type: "THINK", content: "thinking" }] } },
    });
    expect(c1?.reasoningDelta).toBe("thinking");
    expect(c1?.delta).toBe("");

    const c2 = p.apply({
      v: { response: { fragments: [{ type: "RESPONSE", content: "answer" }] } },
    });
    expect(c2?.delta).toBe("answer");
    expect(c2?.reasoningDelta).toBeUndefined();
  });

  it("APPEND after THINK goes to reasoningDelta", () => {
    const p = new DeepSeekPatchParser();
    p.apply({
      v: { response: { fragments: [{ type: "THINK", content: "initial" }] } },
    });
    const chunk = p.apply({
      v: { p: "response/fragments/-1/content", o: "APPEND", v: " continued" },
    });
    expect(chunk?.reasoningDelta).toBe(" continued");
    expect(chunk?.delta).toBe("");
  });

  it("APPEND after RESPONSE goes to delta", () => {
    const p = new DeepSeekPatchParser();
    p.apply({
      v: { response: { fragments: [{ type: "RESPONSE", content: "initial" }] } },
    });
    const chunk = p.apply({
      v: { p: "response/fragments/-1/content", o: "APPEND", v: " more" },
    });
    expect(chunk?.delta).toBe(" more");
    expect(chunk?.reasoningDelta).toBeUndefined();
  });

  it("old format reasoning_content still works", () => {
    const p = new DeepSeekPatchParser();
    const chunk = p.apply({
      data: { type: "response_message", index: 0, message: { content: "" }, reasoning_content: "old reasoning" },
    });
    expect(chunk?.reasoningDelta).toBe("old reasoning");
    expect(chunk?.delta).toBe("");
  });

  it("CRITICAL: THINK snapshot → APPEND → plain text — all to reasoningDelta only", () => {
    const p = new DeepSeekPatchParser();

    const c1 = p.apply({
      v: { response: { fragments: [{ type: "THINK", content: "Let me think..." }] } },
    });
    expect(c1?.reasoningDelta).toBe("Let me think...");
    expect(c1?.delta).toBe("");

    const c2 = p.apply({
      v: { p: "response/fragments/-1/content", o: "APPEND", v: " about this" },
    });
    expect(c2?.reasoningDelta).toBe(" about this");
    expect(c2?.delta).toBe("");

    const c3 = p.apply({
      v: { p: "response/fragments/-1/content", o: "APPEND", v: " carefully." },
    });
    expect(c3?.reasoningDelta).toBe(" carefully.");
    expect(c3?.delta).toBe("");
  });

  it("CRITICAL: RESPONSE snapshot → APPEND — all to delta only", () => {
    const p = new DeepSeekPatchParser();

    const c1 = p.apply({
      v: { response: { fragments: [{ type: "RESPONSE", content: "The answer" }] } },
    });
    expect(c1?.delta).toBe("The answer");
    expect(c1?.reasoningDelta).toBeUndefined();

    const c2 = p.apply({
      v: { p: "response/fragments/-1/content", o: "APPEND", v: " is 42." },
    });
    expect(c2?.delta).toBe(" is 42.");
    expect(c2?.reasoningDelta).toBeUndefined();
  });

  it("BATCH events dispatch correctly", () => {
    const p = new DeepSeekPatchParser();
    p.apply({
      v: {
        response: {
          fragments: [
            { type: "THINK", content: "hmm" },
            { type: "RESPONSE", content: "answer" },
          ],
        },
      },
    });
    expect(p.getFragments()).toHaveLength(2);
  });

  it("two independent parser instances do not share state", () => {
    const p1 = new DeepSeekPatchParser();
    const p2 = new DeepSeekPatchParser();

    p1.apply({
      v: { response: { fragments: [{ type: "THINK", content: "p1 thinking" }] } },
    });

    const c2 = p2.apply({
      v: { response: { fragments: [{ type: "RESPONSE", content: "p2 answer" }] } },
    });
    expect(c2?.delta).toBe("p2 answer");
    expect(c2?.reasoningDelta).toBeUndefined();
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
