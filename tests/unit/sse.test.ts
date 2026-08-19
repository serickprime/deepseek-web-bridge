import { describe, expect, it } from "vitest";
import { DeepSeekPatchParser } from "../../src/deepseek/updateParser.js";
import { SseAccumulator, parseSseBlock } from "../../src/deepseek/sseParser.js";
import { anthropicSseMessageDone, toAnthropicMessage } from "../../src/server/outputAnthropic.js";
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

describe("FIX1: message_start before content_block_start for tool_use", () => {
  it("message_start is emitted before tool_use block", () => {
    const chunks: string[] = [];
    const stream = new ProtocolStream("anthropic", "test-model", c => chunks.push(c));
    stream.start();
    stream.push({ type: "tool_use", toolCall: { id: "call_1", type: "function", name: "Bash", arguments: { command: "ls" } } });
    stream.finish();

    const text = chunks.join("");
    const msgStartIdx = text.indexOf("message_start");
    const blockStartIdx = text.indexOf("content_block_start");
    expect(msgStartIdx).toBeGreaterThanOrEqual(0);
    expect(blockStartIdx).toBeGreaterThan(msgStartIdx);
  });

  it("double start() does not emit message_start twice", () => {
    const chunks: string[] = [];
    const stream = new ProtocolStream("anthropic", "test-model", c => chunks.push(c));
    stream.start();
    stream.start();
    stream.push({ type: "content", text: "hi" });
    stream.finish();

    const text = chunks.join("");
    const matches = text.match(/event: message_start/g);
    expect(matches).toHaveLength(1);
  });
});

describe("FIX3: FINISHED does not leak into fragment content", () => {
  it("bare {v:\"FINISHED\"} after APPEND does not pollute delta", () => {
    const p = new DeepSeekPatchParser();
    const c1 = p.apply({
      v: { response: { fragments: [{ type: "RESPONSE", content: "hello" }] } },
    });
    expect(c1?.delta).toBe("hello");

    const c2 = p.apply({
      v: { p: "response/fragments/-1/content", o: "APPEND", v: " world" },
    });
    expect(c2?.delta).toBe(" world");

    const c3 = p.apply({ v: "FINISHED" });
    expect(c3).toBeNull();
  });

  it("bare {v:\"FINISHED\"} after THINK APPEND does not pollute reasoningDelta", () => {
    const p = new DeepSeekPatchParser();
    p.apply({
      v: { response: { fragments: [{ type: "THINK", content: "reasoning" }] } },
    });
    const c2 = p.apply({
      v: { p: "response/fragments/-1/content", o: "APPEND", v: " more" },
    });
    expect(c2?.reasoningDelta).toBe(" more");

    const c3 = p.apply({ v: "FINISHED" });
    expect(c3).toBeNull();
  });

  it("proper status event still works after reset", () => {
    const p = new DeepSeekPatchParser();
    p.apply({
      v: { response: { fragments: [{ type: "RESPONSE", content: "data" }] } },
    });
    const status = p.apply({
      v: { p: "response/status", o: "SET", v: "FINISHED" },
    });
    expect(status?.done).toBe(true);
    expect(status?.delta).toBe("");
    expect(p.getStatus()).toBe("FINISHED");
  });
});

describe("p/o persistence: bare {v} continues fragment APPEND", () => {
  it("tool call JSON split across events collects fully", () => {
    const p = new DeepSeekPatchParser();
    p.apply({ v: { response: { fragments: [{ type: "RESPONSE", content: "" }] } } });

    const c1 = p.apply({ v: { p: "response/fragments/-1/content", o: "APPEND", v: "{\"tool" } });
    expect(c1?.delta).toBe("{\"tool");

    const c2 = p.apply({ v: "_call\":" });
    expect(c2?.delta).toBe("_call\":");

    const c3 = p.apply({ v: "{\"name\":\"Bash\"}}" });
    expect(c3?.delta).toBe("{\"name\":\"Bash\"}}");

    expect(p.getFragments()[0]!.content).toBe("{\"tool_call\":{\"name\":\"Bash\"}}");
  });

  it("THINK APPEND → bare continuation goes to reasoningDelta", () => {
    const p = new DeepSeekPatchParser();
    p.apply({ v: { response: { fragments: [{ type: "THINK", content: "" }] } } });

    const c1 = p.apply({ v: { p: "response/fragments/-1/content", o: "APPEND", v: "reasoning" } });
    expect(c1?.reasoningDelta).toBe("reasoning");

    const c2 = p.apply({ v: " continuation" });
    expect(c2?.reasoningDelta).toBe(" continuation");
    expect(c2?.delta).toBe("");
  });

  it("RESPONSE APPEND → bare continuation goes to delta", () => {
    const p = new DeepSeekPatchParser();
    p.apply({ v: { response: { fragments: [{ type: "RESPONSE", content: "" }] } } });

    const c1 = p.apply({ v: { p: "response/fragments/-1/content", o: "APPEND", v: "response" } });
    expect(c1?.delta).toBe("response");

    const c2 = p.apply({ v: " continuation" });
    expect(c2?.delta).toBe(" continuation");
  });

  it("bare FINISHED after fragment APPEND does not pollute content", () => {
    const p = new DeepSeekPatchParser();
    p.apply({ v: { response: { fragments: [{ type: "RESPONSE", content: "" }] } } });

    const c1 = p.apply({ v: { p: "response/fragments/-1/content", o: "APPEND", v: "text" } });
    expect(c1?.delta).toBe("text");

    const c2 = p.apply({ v: "FINISHED" });
    expect(c2).toBeNull();
  });
});

describe("FIX2: toAnthropicMessage does not include raw JSON text when tool_call present", () => {
  it("tool_use result has tool_use block and no text block", () => {
    const result = {
      content: "",
      toolCalls: [{ id: "call_1", type: "function" as const, name: "Bash", arguments: { command: "ls" } }],
    };
    const msg = toAnthropicMessage(result, "test-model");
    const textBlocks = msg.content.filter(b => b.type === "text");
    const toolBlocks = msg.content.filter(b => b.type === "tool_use");
    expect(textBlocks).toHaveLength(0);
    expect(toolBlocks).toHaveLength(1);
    expect(toolBlocks[0]!.name).toBe("Bash");
    expect(msg.stop_reason).toBe("tool_use");
  });

  it("text-only result has text block and no tool_use block", () => {
    const result = { content: "hello world", toolCalls: [] };
    const msg = toAnthropicMessage(result, "test-model");
    const textBlocks = msg.content.filter(b => b.type === "text");
    const toolBlocks = msg.content.filter(b => b.type === "tool_use");
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0]!.text).toBe("hello world");
    expect(toolBlocks).toHaveLength(0);
    expect(msg.stop_reason).toBe("end_turn");
  });
});

describe("Anthropic SSE lifecycle: text", () => {
  it("full start/delta/stop lifecycle for plain text", () => {
    const chunks: string[] = [];
    const stream = new ProtocolStream("anthropic", "test-model", c => chunks.push(c));
    stream.start();
    stream.push({ type: "content", text: "hello" });
    stream.finish();

    const text = chunks.join("");
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_start");
    expect(text).toContain('"type":"text"');
    expect(text).toContain("event: content_block_delta");
    expect(text).toContain('"type":"text_delta"');
    expect(text).toContain('"text":"hello"');
    expect(text).toContain("event: content_block_stop");
    expect(text).toContain("event: message_delta");
    expect(text).toContain('"stop_reason":"end_turn"');
    expect(text).toContain("event: message_stop");
  });

  it("result.content appears in SSE as text_delta", () => {
    const chunks: string[] = [];
    const stream = new ProtocolStream("anthropic", "m", c => chunks.push(c));
    stream.start();
    stream.push({ type: "content", text: "The answer is 42." });
    stream.finish();

    const text = chunks.join("");
    expect(text).toContain('"text":"The answer is 42."');
    expect(text).toContain('"type":"text_delta"');
  });

  it("multiple content pushes share one text block", () => {
    const chunks: string[] = [];
    const stream = new ProtocolStream("anthropic", "m", c => chunks.push(c));
    stream.start();
    stream.push({ type: "content", text: "aa" });
    stream.push({ type: "content", text: "bb" });
    stream.finish();

    const text = chunks.join("");
    const blockStarts = text.match(/event: content_block_start/g);
    const blockStops = text.match(/event: content_block_stop/g);
    expect(blockStarts).toHaveLength(1);
    expect(blockStops).toHaveLength(1);
    expect(text).toContain('"text":"aa"');
    expect(text).toContain('"text":"bb"');
  });

  it("text block index is 0", () => {
    const chunks: string[] = [];
    const stream = new ProtocolStream("anthropic", "m", c => chunks.push(c));
    stream.start();
    stream.push({ type: "content", text: "x" });
    stream.finish();

    const text = chunks.join("");
    const blockStart = text.match(/event: content_block_start\ndata: ({.*?})\n\n/);
    expect(blockStart).not.toBeNull();
    const parsed = JSON.parse(blockStart![1]!);
    expect(parsed.index).toBe(0);
  });
});

describe("Anthropic SSE lifecycle: tool_use", () => {
  it("tool_use content_block_start contains input:{}", () => {
    const chunks: string[] = [];
    const stream = new ProtocolStream("anthropic", "m", c => chunks.push(c));
    stream.start();
    stream.push({
      type: "tool_use",
      toolCall: { id: "call_1", type: "function", name: "Bash", arguments: { command: "ls" } },
    });
    stream.finish();

    const text = chunks.join("");
    expect(text).toContain('"input":{}');
    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"name":"Bash"');
    expect(text).toContain('"id":"call_1"');
  });

  it("tool SSE has correct event order", () => {
    const chunks: string[] = [];
    const stream = new ProtocolStream("anthropic", "m", c => chunks.push(c));
    stream.start();
    stream.push({
      type: "tool_use",
      toolCall: { id: "c1", type: "function", name: "Grep", arguments: { pattern: "foo" } },
    });
    stream.finish();

    const text = chunks.join("");
    const events = [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ];
    let pos = -1;
    for (const ev of events) {
      const idx = text.indexOf(`event: ${ev}`, pos + 1);
      expect(idx).toBeGreaterThan(pos);
      pos = idx;
    }
  });

  it("tool_use stop_reason is tool_use", () => {
    const chunks: string[] = [];
    const stream = new ProtocolStream("anthropic", "m", c => chunks.push(c));
    stream.start();
    stream.push({
      type: "tool_use",
      toolCall: { id: "c1", type: "function", name: "Bash", arguments: {} },
    });
    stream.finish();

    const text = chunks.join("");
    expect(text).toContain('"stop_reason":"tool_use"');
  });
});

describe("Anthropic SSE: raw tool JSON does not appear as text", () => {
  it("tool_use response has no text_delta", () => {
    const chunks: string[] = [];
    const stream = new ProtocolStream("anthropic", "m", c => chunks.push(c));
    stream.start();
    stream.push({
      type: "tool_use",
      toolCall: { id: "c1", type: "function", name: "Bash", arguments: { command: "ls" } },
    });
    stream.finish();

    const text = chunks.join("");
    expect(text).not.toContain('"type":"text_delta"');
    expect(text).not.toContain('"type":"text"');
  });
});

describe("Anthropic SSE: reasoning does not appear in visible text", () => {
  it("thinking block is separate from text block", () => {
    const chunks: string[] = [];
    const stream = new ProtocolStream("anthropic", "m", c => chunks.push(c));
    stream.start();
    stream.push({ type: "thinking", text: "internal reasoning" });
    stream.push({ type: "content", text: "visible answer" });
    stream.finish();

    const text = chunks.join("");
    expect(text).toContain('"type":"thinking"');
    expect(text).toContain('"thinking":"internal reasoning"');
    expect(text).toContain('"type":"text_delta"');
    expect(text).toContain('"text":"visible answer"');
    expect(text).toContain('"stop_reason":"end_turn"');
  });

  it("thinking block index increments past text block", () => {
    const chunks: string[] = [];
    const stream = new ProtocolStream("anthropic", "m", c => chunks.push(c));
    stream.start();
    stream.push({ type: "content", text: "answer" });
    stream.push({ type: "thinking", text: "reasoning" });
    stream.finish();

    const text = chunks.join("");
    const blockStarts = text.match(/event: content_block_start/g);
    expect(blockStarts).toHaveLength(2);
    expect(text).toContain('"stop_reason":"end_turn"');
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
