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
