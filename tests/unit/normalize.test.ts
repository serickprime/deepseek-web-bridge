import { describe, expect, it } from "vitest";
import { normalizeOpenAI } from "../../src/api/normalizeOpenAI.js";
import { normalizeAnthropic } from "../../src/api/normalizeAnthropic.js";
import { normalizeResponses } from "../../src/api/normalizeResponses.js";

describe("normalizeOpenAI", () => {
  it("parses basic chat request", () => {
    const req = normalizeOpenAI(
      {
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hello!" },
        ],
        stream: false,
      },
      {},
    );
    expect(req.model).toBe("deepseek-chat");
    expect(req.system).toBe("You are helpful.");
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]?.parts[0]).toEqual({ type: "text", text: "Hello!" });
    expect(req.stream).toBe(false);
  });

  it("parses assistant tool_calls and tool results", () => {
    const req = normalizeOpenAI(
      {
        messages: [
          { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: '{"file_path":"a.txt"}' } }] },
          { role: "tool", tool_call_id: "call_1", content: "file contents" },
        ],
      },
      {},
    );
    expect(req.messages[0]?.parts[0]?.toolCall?.name).toBe("Read");
    expect(req.messages[1]?.parts[0]?.toolResult).toEqual({
      toolUseId: "call_1",
      content: "file contents",
      isError: false,
    });
  });

  it("preserves OpenAI system content arrays as a regression control", () => {
    const req = normalizeOpenAI({
      messages: [{
        role: "system",
        content: [
          { type: "text", text: "OPENAI-SYS-A" },
          { type: "text", text: "OPENAI-SYS-B" },
        ],
      }],
    }, {});
    expect(req.system).toBe("OPENAI-SYS-A\nOPENAI-SYS-B");
  });
});

describe("normalizeAnthropic", () => {
  it("parses messages with blocks", () => {
    const req = normalizeAnthropic(
      {
        model: "claude-3-5-haiku",
        system: "Be brief.",
        messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      },
      {},
    );
    expect(req.system).toBe("Be brief.");
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]?.parts[0]?.text).toBe("Hi");
  });

  it("preserves a string system prompt exactly", () => {
    const system = "  SYS-STRING\nsecond line  ";
    expect(normalizeAnthropic({ system, messages: [] }, {}).system).toBe(system);
  });

  it("normalizes one top-level system text block", () => {
    expect(normalizeAnthropic({
      system: [{ type: "text", text: "SYS-A" }],
      messages: [],
    }, {}).system).toBe("SYS-A");
  });

  it("joins top-level system text blocks in order with one newline", () => {
    expect(normalizeAnthropic({
      system: [
        { type: "text", text: "SYS-A" },
        { type: "text", text: "SYS-B" },
        { type: "text", text: "SYS-C-ёжик" },
      ],
      messages: [],
    }, {}).system).toBe("SYS-A\nSYS-B\nSYS-C-ёжик");
  });

  it("preserves internal whitespace and newlines in every system block", () => {
    expect(normalizeAnthropic({
      system: [
        { type: "text", text: "  SYS-A\ninner  " },
        { type: "text", text: "\nSYS-B\t" },
      ],
      messages: [],
    }, {}).system).toBe("  SYS-A\ninner  \n\nSYS-B\t");
  });

  it("normalizes an empty or absent top-level system to an empty string", () => {
    expect(normalizeAnthropic({ system: [], messages: [] }, {}).system).toBe("");
    expect(normalizeAnthropic({ messages: [] }, {}).system).toBe("");
  });

  it("ignores metadata on valid top-level system text blocks", () => {
    expect(normalizeAnthropic({
      system: [{
        type: "text",
        text: "SYS-CACHED",
        cache_control: { type: "ephemeral" },
      }],
      messages: [],
    }, {}).system).toBe("SYS-CACHED");
  });

  it("preserves user and assistant message contents and order with a system array", () => {
    const req = normalizeAnthropic({
      system: [{ type: "text", text: "SYS" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "USER-A" }] },
        { role: "assistant", content: [{ type: "text", text: "ASSISTANT-A" }] },
        { role: "user", content: [{ type: "text", text: "USER-B" }] },
      ],
    }, {});
    expect(req.messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "USER-A" }] },
      { role: "assistant", parts: [{ type: "text", text: "ASSISTANT-A" }] },
      { role: "user", parts: [{ type: "text", text: "USER-B" }] },
    ]);
  });

  it.each([
    ["unsupported block type", [{ type: "text", text: "SYS-A" }, { type: "image", source: {} }]],
    ["non-object array item", [{ type: "text", text: "SYS-A" }, "SYS-B"]],
    ["missing block text", [{ type: "text" }]],
    ["non-string block text", [{ type: "text", text: 42 }]],
    ["number system", 42],
    ["object system", { type: "text", text: "SYS-A" }],
    ["null system", null],
  ])("rejects malformed top-level system: %s", (_label, system) => {
    expect(() => normalizeAnthropic({ system, messages: [] }, {})).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST", status: 400 }),
    );
  });

  it("parses tool_use and tool_result blocks", () => {
    const req = normalizeAnthropic(
      {
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "data" }] },
        ],
      },
      {},
    );
    expect(req.messages[0]?.parts[0]?.toolCall?.name).toBe("Read");
    expect(req.messages[1]?.parts[0]?.toolResult?.toolUseId).toBe("t1");
  });

  it("keeps Thinking as a separate capability", () => {
    expect(normalizeAnthropic({
      model: "deepseek-v4-pro",
      thinking: { type: "enabled" },
      messages: [],
    }, {}).reasoning).toBe(true);
    expect(normalizeAnthropic({
      model: "deepseek-v4-pro",
      thinking: { type: "disabled" },
      messages: [],
    }, {}).reasoning).toBe(false);
  });
});

describe("normalizeResponses", () => {
  it("parses instructions and input", () => {
    const req = normalizeResponses(
      {
        instructions: "Be concise.",
        input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
      },
      {},
    );
    expect(req.system).toBe("Be concise.");
    expect(req.messages[0]?.parts[0]?.text).toBe("Hello");
  });
});

describe("V4 defaults", () => {
  it("defaults all protocols to V4 Flash without forcing Thinking", () => {
    expect(normalizeOpenAI({ messages: [] }, {})).toMatchObject({
      model: "deepseek-v4-flash",
      reasoning: undefined,
    });
    expect(normalizeAnthropic({ messages: [] }, {})).toMatchObject({
      model: "deepseek-v4-flash",
      reasoning: undefined,
    });
    expect(normalizeResponses({ input: [] }, {})).toMatchObject({
      model: "deepseek-v4-flash",
      reasoning: undefined,
    });
  });
});
