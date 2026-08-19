import { describe, expect, it } from "vitest";
import { parseToolInvocation, hasToolTag, createToolRetryPrompt, historicalToolInvocationText, toolResultText } from "../../src/tools/toolParser.js";
import { buildToolPrompt } from "../../src/tools/toolPrompt.js";
import { ToolRetryTracker } from "../../src/tools/toolRetry.js";
import { shouldRetry, buildToolUseIdMap } from "../../src/deepseek/client.js";
import type { CanonicalMessage } from "../../src/api/canonical.js";

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

  it("contains mandatory action-execution rule", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toContain("IMMEDIATELY return a tool_call JSON");
  });

  it("contains no-confirmation rule", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/Do NOT ask for confirmation/i);
  });

  it("contains text-response-forbidden rule", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/text response instead of a tool_call is FORBIDDEN/i);
  });

  it("contains no-explanation rule", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/Do NOT explain what you are going to do/i);
  });

  it("contains no-command-as-text rule", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/Do NOT show the command as plain text/i);
  });

  it("contains auto-continuation after tool_result", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toContain("After receiving a tool_result: automatically continue");
    expect(prompt).toMatch(/call it immediately/i);
  });

  it("contains do-not-wait-for-user rule", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/Do NOT wait for a new user message/i);
  });

  it("contains immediate-execution on confirmation phrases", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toContain("do it");
    expect(prompt).toContain("execute");
    expect(prompt).toContain("continue");
    expect(prompt).toMatch(/execute via tool immediately/i);
  });

  it("contains forbidden phrase examples", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toContain("I will execute");
    expect(prompt).toContain("Let me run");
    expect(prompt).toContain("Use the command");
    expect(prompt).toMatch(/ls \.\.\./);
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

describe("tool_result name correlation (buildToolUseIdMap)", () => {
  function msgs(...parts: CanonicalMessage["parts"][]): CanonicalMessage[] {
    return parts.map(p => ({ role: "assistant" as const, parts: p }));
  }

  it("maps Read tool_use id=abc to name Read", () => {
    const messages: CanonicalMessage[] = [
      { role: "assistant", parts: [
        { type: "tool_use", toolCall: { id: "abc", type: "function", name: "Read", arguments: {} } },
      ] },
      { role: "user", parts: [
        { type: "tool_result", toolResult: { toolUseId: "abc", content: "file not found" } },
      ] },
    ];
    const map = buildToolUseIdMap(messages);
    expect(map.get("abc")).toBe("Read");
    const toolName = map.get("abc") ?? "unknown";
    const text = toolResultText(toolName, "abc", "file not found");
    expect(text).toContain("name: Read");
    expect(text).toContain("call_id: abc");
    expect(text).toContain("file not found");
  });

  it("maps Bash tool_use id=xyz to name Bash", () => {
    const messages: CanonicalMessage[] = [
      { role: "assistant", parts: [
        { type: "tool_use", toolCall: { id: "xyz", type: "function", name: "Bash", arguments: { command: "pwd" } } },
      ] },
      { role: "user", parts: [
        { type: "tool_result", toolResult: { toolUseId: "xyz", content: "D:\\Photo" } },
      ] },
    ];
    const map = buildToolUseIdMap(messages);
    const toolName = map.get("xyz") ?? "unknown";
    const text = toolResultText(toolName, "xyz", "D:\\Photo");
    expect(text).toContain("name: Bash");
    expect(text).toContain("D:\\Photo");
  });

  it("handles multiple different tool_uses", () => {
    const messages: CanonicalMessage[] = [
      { role: "assistant", parts: [
        { type: "tool_use", toolCall: { id: "id1", type: "function", name: "Read", arguments: {} } },
        { type: "tool_use", toolCall: { id: "id2", type: "function", name: "Bash", arguments: {} } },
        { type: "tool_use", toolCall: { id: "id3", type: "function", name: "Write", arguments: {} } },
      ] },
    ];
    const map = buildToolUseIdMap(messages);
    expect(map.size).toBe(3);
    expect(map.get("id1")).toBe("Read");
    expect(map.get("id2")).toBe("Bash");
    expect(map.get("id3")).toBe("Write");
  });

  it("unknown id returns fallback", () => {
    const messages: CanonicalMessage[] = [
      { role: "assistant", parts: [
        { type: "tool_use", toolCall: { id: "abc", type: "function", name: "Read", arguments: {} } },
      ] },
    ];
    const map = buildToolUseIdMap(messages);
    expect(map.has("nonexistent")).toBe(false);
    const toolName = map.get("nonexistent") ?? "unknown";
    expect(toolName).toBe("unknown");
  });

  it("error tool_result carries name correctly", () => {
    const messages: CanonicalMessage[] = [
      { role: "assistant", parts: [
        { type: "tool_use", toolCall: { id: "err1", type: "function", name: "Read", arguments: {} } },
      ] },
      { role: "user", parts: [
        { type: "tool_result", toolResult: { toolUseId: "err1", content: "ENOENT: no such file", isError: true } },
      ] },
    ];
    const map = buildToolUseIdMap(messages);
    const toolName = map.get("err1") ?? "unknown";
    const text = toolResultText(toolName, "err1", "ENOENT: no such file");
    expect(text).toContain("name: Read");
    expect(text).toContain("ENOENT: no such file");
  });

  it("chain: failed Read → Bash → Write correlates correctly", () => {
    const messages: CanonicalMessage[] = [
      { role: "assistant", parts: [
        { type: "tool_use", toolCall: { id: "r1", type: "function", name: "Read", arguments: {} } },
      ] },
      { role: "user", parts: [
        { type: "tool_result", toolResult: { toolUseId: "r1", content: "ENOENT", isError: true } },
      ] },
      { role: "assistant", parts: [
        { type: "tool_use", toolCall: { id: "b1", type: "function", name: "Bash", arguments: {} } },
      ] },
      { role: "user", parts: [
        { type: "tool_result", toolResult: { toolUseId: "b1", content: "ok" } },
      ] },
      { role: "assistant", parts: [
        { type: "tool_use", toolCall: { id: "w1", type: "function", name: "Write", arguments: {} } },
      ] },
      { role: "user", parts: [
        { type: "tool_result", toolResult: { toolUseId: "w1", content: "written" } },
      ] },
    ];
    const map = buildToolUseIdMap(messages);
    expect(map.get("r1")).toBe("Read");
    expect(map.get("b1")).toBe("Bash");
    expect(map.get("w1")).toBe("Write");

    const textR = toolResultText(map.get("r1") ?? "unknown", "r1", "ENOENT");
    const textB = toolResultText(map.get("b1") ?? "unknown", "b1", "ok");
    const textW = toolResultText(map.get("w1") ?? "unknown", "w1", "written");
    expect(textR).toContain("name: Read");
    expect(textB).toContain("name: Bash");
    expect(textW).toContain("name: Write");
  });

  it("empty messages returns empty map", () => {
    const map = buildToolUseIdMap([]);
    expect(map.size).toBe(0);
  });

  it("ignores text and tool_result parts", () => {
    const messages: CanonicalMessage[] = [
      { role: "assistant", parts: [
        { type: "text", text: "some text" },
        { type: "tool_result", toolResult: { toolUseId: "x", content: "y" } },
      ] },
    ];
    const map = buildToolUseIdMap(messages);
    expect(map.size).toBe(0);
  });
});
