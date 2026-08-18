import { describe, expect, it } from "vitest";
import { parseToolInvocation, hasToolTag, createToolRetryPrompt, historicalToolInvocationText, toolResultText } from "../../src/tools/toolParser.js";
import { buildToolPrompt } from "../../src/tools/toolPrompt.js";
import { ToolRetryTracker } from "../../src/tools/toolRetry.js";

const TOOLS = new Set(["Read", "Search", "get_weather", "calculate"]);

describe("toolParser", () => {
  it("parses strict tool_call JSON", () => {
    const result = parseToolInvocation('{"tool_call":{"name":"Read","arguments":{"file_path":"a.txt"}}}', TOOLS);
    expect(result.toolCall).not.toBeNull();
    expect(result.toolCall?.name).toBe("Read");
    expect(result.toolCall?.arguments).toEqual({ file_path: "a.txt" });
    expect(result.text).toBe("");
  });

  it("parses <tool_call> wrapper JSON", () => {
    const result = parseToolInvocation(
      '<tool_call>{"name":"Read","arguments":{"file_path":"a.txt"}}</tool_call>',
      TOOLS,
    );
    expect(result.toolCall).not.toBeNull();
    expect(result.toolCall?.name).toBe("Read");
    expect(result.toolCall?.arguments).toEqual({ file_path: "a.txt" });
  });

  it("rejects unknown tool name", () => {
    const result = parseToolInvocation('{"tool_call":{"name":"Hacker","arguments":{}}}', TOOLS);
    expect(result.toolCall).toBeNull();
  });

  it("rejects invalid tool_call shape", () => {
    const result = parseToolInvocation('{"tool_call":"not_an_object"}', TOOLS);
    expect(result.toolCall).toBeNull();
  });

  it("rejects tool_call with extra keys in outer envelope", () => {
    const result = parseToolInvocation('{"tool_call":{"name":"Read","arguments":{}},"extra":1}', TOOLS);
    expect(result.toolCall).toBeNull();
  });

  it("rejects prototype pollution in tool_call wrapper", () => {
    const result = parseToolInvocation(
      '{"tool_call":{"name":"Read","arguments":{"__proto__":{"x":"1"},"file_path":"a"}}}',
      TOOLS,
    );
    expect(result.toolCall).toBeNull();
  });

  it("returns null for plain text", () => {
    const result = parseToolInvocation("just a normal answer", TOOLS);
    expect(result.text).toBe("just a normal answer");
    expect(result.toolCall).toBeNull();
  });

  it("hasToolTag detects JSON markers", () => {
    expect(hasToolTag("<tool_call>...</tool_call>")).toBe(true);
    expect(hasToolTag('{"tool_call":{}}')).toBe(true);
    expect(hasToolTag("plain text")).toBe(false);
  });

  it("extracts tool_call JSON embedded in prose text", () => {
    const result = parseToolInvocation(
      'We need to use the get_weather tool. tool_call>{"name":"get_weather","arguments":{"location":"Moscow"}}</tool_call>',
      TOOLS,
    );
    expect(result.toolCall).not.toBeNull();
    expect(result.toolCall?.name).toBe("get_weather");
    expect(result.toolCall?.arguments).toEqual({ location: "Moscow" });
  });

  it("extracts tool_call JSON when prefix is truncated", () => {
    const result = parseToolInvocation(
      'tool_call":{"name":"Read","arguments":{"file_path":"a.txt"}}}',
      TOOLS,
    );
    expect(result.toolCall).not.toBeNull();
    expect(result.toolCall?.name).toBe("Read");
  });

  it("extracts bare {name, arguments} JSON in prose", () => {
    const result = parseToolInvocation(
      'Output the tool call.{"name":"get_weather","arguments":{"location":"Paris"}}',
      TOOLS,
    );
    expect(result.toolCall).not.toBeNull();
    expect(result.toolCall?.name).toBe("get_weather");
  });
});

describe("toolPrompt", () => {
  it("builds prompt with TOOL REQUEST SYSTEM", () => {
    const prompt = buildToolPrompt([
      { name: "Read", description: "Read a file", inputSchema: { type: "object" } },
    ]);
    expect(prompt).toContain("TOOL REQUEST SYSTEM");
    expect(prompt).toContain("tool_call");
    expect(prompt).toContain("Read");
  });

  it("returns empty for no tools", () => {
    expect(buildToolPrompt([])).toBe("");
  });
});

describe("historical format", () => {
  it("builds historical invocation text", () => {
    const text = historicalToolInvocationText("Read", "call_123", { file_path: "a.txt" });
    expect(text).toContain("Historical Action Record");
    expect(text).toContain("Read");
    expect(text).toContain("call_123");
  });

  it("builds tool result text", () => {
    const text = toolResultText("Read", "call_123", "file contents here");
    expect(text).toContain("[Tool Result]");
    expect(text).toContain("Read");
    expect(text).toContain("file contents here");
  });
});

describe("toolRetry", () => {
  it("allows limited retries then blocks", () => {
    const tracker = new ToolRetryTracker(1);
    expect(tracker.canRetry("call-1")).toBe(true);
    tracker.recordFailure("call-1");
    expect(tracker.canRetry("call-1")).toBe(false);
    expect(tracker.canRetry("call-2")).toBe(true);
  });

  it("reset clears attempts", () => {
    const tracker = new ToolRetryTracker(1);
    tracker.recordFailure("call-1");
    tracker.reset("call-1");
    expect(tracker.canRetry("call-1")).toBe(true);
  });
});

describe("createToolRetryPrompt", () => {
  it("includes allowed tool names", () => {
    const prompt = createToolRetryPrompt(["Read", "Search"]);
    expect(prompt).toContain("Read");
    expect(prompt).toContain("Search");
    expect(prompt).toContain("tool_call");
  });
});
