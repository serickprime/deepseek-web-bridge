import { describe, expect, it } from "vitest";
import { parseToolInvocation, hasToolTag, createToolRetryPrompt, historicalToolInvocationText, toolResultText } from "../../src/tools/toolParser.js";
import { buildToolPrompt } from "../../src/tools/toolPrompt.js";
import { ToolRetryTracker } from "../../src/tools/toolRetry.js";
import { shouldRetry } from "../../src/deepseek/client.js";

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
  const tools = [
    { name: "Read", description: "Read a file from the filesystem", inputSchema: { type: "object", properties: { file_path: { type: "string" } } } },
    { name: "Grep", description: "Search in file contents with regex", inputSchema: { type: "object", properties: { pattern: { type: "string" } } } },
  ];

  it("contains tool description", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toContain("Read a file from the filesystem");
  });

  it("contains tool name", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toContain("- Read");
    expect(prompt).toContain("- Grep");
  });

  it("contains argument names", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toContain("file_path");
    expect(prompt).toContain("pattern");
  });

  it("contains most specific tool rule", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/most specific/i);
  });

  it("contains do not use general shell tool rule", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/Do not use a general shell\/command tool/i);
  });

  it("allows plain text when no tool is needed", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/plain text/i);
  });

  it("requires JSON-only when tool is needed", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toContain("exactly one JSON object");
  });

  it("does not contain old contradictory line", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).not.toContain("Your entire response must be EXACTLY one JSON object");
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

describe("shouldRetry", () => {
  it("no retry when tools present but model answered with text", () => {
    expect(shouldRetry(true, null, "TypeScript — это язык...", "some reasoning")).toBe(false);
  });

  it("retry when tools present, content empty, reasoning exists", () => {
    expect(shouldRetry(true, null, "", "Нужно прочитать файл...")).toBe(true);
  });

  it("no retry when tool call found", () => {
    expect(shouldRetry(true, { name: "Read", arguments: {} }, "", "")).toBe(false);
  });

  it("no retry when no tools provided", () => {
    expect(shouldRetry(false, null, "", "reasoning")).toBe(false);
  });
});
