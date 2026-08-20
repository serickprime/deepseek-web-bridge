import { describe, expect, it } from "vitest";
import { parseToolInvocation, hasToolTag, createToolRetryPrompt, historicalToolInvocationText, sanitizedToolInvocationText, toolResultText, looksLikeToolIntentText, looksLikeFakeToolTrace, COMPLETION_GUARD_MAX_ATTEMPTS, buildUpstreamPrompt } from "../../src/tools/toolParser.js";
import { buildToolPrompt } from "../../src/tools/toolPrompt.js";
import { ToolRetryTracker } from "../../src/tools/toolRetry.js";
import { DeepSeekClient, shouldRetry, buildToolUseIdMap } from "../../src/deepseek/client.js";
import type { CanonicalMessage, CanonicalRequest } from "../../src/api/canonical.js";
import type { UpstreamSessionState } from "../../src/sessions/sessionStore.js";

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

  it("contains PATH RULES section", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toContain("PATH RULES (mandatory)");
  });

  it("contains cwd-as-source-of-truth rule", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/current working directory[\s\S]*?is the ONLY source of truth/i);
  });

  it("contains do-not-invent-absolute-paths rule", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/NEVER invent absolute paths/i);
    expect(prompt).toContain("C:\\Users\\...");
    expect(prompt).toContain("/home/...");
  });

  it("contains resolve-from-cwd rule", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/resolve it relative to the cwd/i);
  });

  it("contains confirm-cwd-first rule", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/first run a Bash tool to confirm the real cwd/i);
  });

  it("contains explicit-user-path exception", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/Explicitly user-provided absolute paths/i);
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

describe("toolPrompt — completion guard rules", () => {
  const tools = [
    { name: "Read", description: "Read a file", inputSchema: { type: "object", properties: { file_path: { type: "string" } } } },
    { name: "Bash", description: "Run a command", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
  ];

  it("contains COMPLETION GUARD section", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toContain("COMPLETION GUARD (mandatory)");
  });

  it("contains FINAL ANSWER RULES section", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toContain("FINAL ANSWER RULES (mandatory)");
  });

  it("requires all actions executed before final answer", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/final answer is allowed ONLY when ALL actions/i);
  });

  it("requires real tool_result confirmation", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/confirmed by a real[\s\S]*?tool_result/i);
  });

  it("prohibits counting actions from text/reasoning/history/compact", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/Do NOT count an action as done because it was/i);
    expect(prompt).toMatch(/mentioned in text, reasoning, history, or compact summary/i);
  });

  it("requires check after each tool_result", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/After every tool_result, check/i);
  });

  it("forbids claiming success without tool_result", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/NEVER write.*created.*read.*verified.*done.*written/i);
    expect(prompt).toMatch(/unless the corresponding tool_result exists/i);
  });

  it("compact summaries are context only", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/Compact summaries are context only/i);
    expect(prompt).toMatch(/they do NOT prove[\s\S]*?specific tool was executed/i);
  });

  it("requires mental enumeration of actions before final answer", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/enumerate every concrete[\s\S]*?action/i);
  });

  it("requires tool_result with success indicator", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/tool_result with a success[\s\S]*?indicator exists/i);
  });

  it("requires calling tool if action missing", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/action is missing its tool_result.*call the tool first/i);
  });

  it("requires honest error reporting", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/tool_result shows an error.*report the error honestly/i);
  });

  it("requires extra verification when in doubt", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/perform an extra verification tool call/i);
  });

  it("rule 10a enumerates actions", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toContain("10. FINAL ANSWER RULES");
    expect(prompt).toContain("A) Before giving a final answer");
  });

  it("rule 10b confirms success indicator", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toContain("B) For each action, confirm that a tool_result");
  });

  it("rule 10c calls tool when missing", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toContain("C) If any action is missing its tool_result");
  });

  it("rule 10d reports error honestly", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toContain("D) If a tool_result shows an error");
  });

  it("rule 10e extra verification", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toContain("E) When in doubt, perform an extra verification");
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

describe("looksLikeToolIntentText", () => {
  it("Russian intent with tool name → true", () => {
    expect(looksLikeToolIntentText("Я попробую прочитать файл через Read.", ["Read"])).toBe(true);
  });

  it("Russian intent with action verb + object → true", () => {
    expect(looksLikeToolIntentText("Я выполню команду через Bash.", ["Bash"])).toBe(true);
  });

  it("English intent with tool name → true", () => {
    expect(looksLikeToolIntentText("Let me read the file using Read.", ["Read"])).toBe(true);
  });

  it("English intent 'I'll run' with tool name → true", () => {
    expect(looksLikeToolIntentText("I'll run this with Bash.", ["Bash"])).toBe(true);
  });

  it("normal final answer → false", () => {
    expect(looksLikeToolIntentText("Файл не найден, проверьте путь.", ["Read"])).toBe(false);
  });

  it("question about tool → false", () => {
    expect(looksLikeToolIntentText("Что такое Read tool?", ["Read"])).toBe(false);
  });

  it("long text > 300 chars → false", () => {
    const long = "Я попробую ".repeat(50);
    expect(looksLikeToolIntentText(long, ["Read"])).toBe(false);
  });

  it("no tools available → false", () => {
    expect(looksLikeToolIntentText("Я попробую прочитать файл.", [])).toBe(false);
  });

  it("empty content → false", () => {
    expect(looksLikeToolIntentText("", ["Read"])).toBe(false);
  });

  it("intent without tool name or action object → false", () => {
    expect(looksLikeToolIntentText("Я попробую понять ситуацию.", ["Read"])).toBe(false);
  });

  it("Russian 'давай я' with tool name → true", () => {
    expect(looksLikeToolIntentText("Давай я создам файл через Write.", ["Write"])).toBe(true);
  });

  it("Russian 'сейчас я' with action object → true", () => {
    expect(looksLikeToolIntentText("Сейчас я проверю директорию.", ["Bash"])).toBe(true);
  });

  it("English 'I can read' → true", () => {
    expect(looksLikeToolIntentText("I can read the file for you.", ["Read"])).toBe(true);
  });

  it("English 'I will create' → true", () => {
    expect(looksLikeToolIntentText("I will create the file.", ["Write"])).toBe(true);
  });
});

describe("shouldRetry with intent text", () => {
  const tools = ["Read", "Bash", "Write"];

  it("Russian intent text + tools → retry", () => {
    expect(shouldRetry(true, null, "Я попробую прочитать файл через Read.", "", tools)).toBe(true);
  });

  it("English intent text + tools → retry", () => {
    expect(shouldRetry(true, null, "Let me read the file using Read.", "", tools)).toBe(true);
  });

  it("normal answer + tools → no retry", () => {
    expect(shouldRetry(true, null, "Файл не найден.", "", tools)).toBe(false);
  });

  it("question + tools → no retry", () => {
    expect(shouldRetry(true, null, "Что такое Read tool?", "", tools)).toBe(false);
  });

  it("long text + tools → no retry", () => {
    const long = "Я попробую ".repeat(50);
    expect(shouldRetry(true, null, long, "", tools)).toBe(false);
  });

  it("no tools → no retry", () => {
    expect(shouldRetry(false, null, "Я попробую прочитать файл.", "", [])).toBe(false);
  });

  it("toolCall found → no retry", () => {
    expect(shouldRetry(true, { name: "Read", arguments: {} }, "Я попробую прочитать.", "", tools)).toBe(false);
  });

  it("empty content + reasoning → retry (legacy)", () => {
    expect(shouldRetry(true, null, "", "Нужно прочитать файл...", tools)).toBe(true);
  });

  it("empty content + no reasoning → no retry", () => {
    expect(shouldRetry(true, null, "", "", tools)).toBe(false);
  });
});

describe("looksLikeFakeToolTrace", () => {
  const TOOLS = ["Read", "Write", "Bash", "Edit"];

  it("'Read file: ...' is detected as fake trace", () => {
    expect(looksLikeFakeToolTrace("Read file: D:\\test\\foo.txt", TOOLS)).toBe(true);
  });

  it("'Write file: ...' is detected as fake trace", () => {
    expect(looksLikeFakeToolTrace("Write file: C:\\Users\\out.txt", TOOLS)).toBe(true);
  });

  it("multiple Write/Read lines are detected", () => {
    const text = [
      "Read file: D:\\test CC NODE\\compact-guard-test\\does-not-exist.txt",
      "Write file: D:\\test CC NODE\\compact-guard-test\\recovery.txt",
      "Read file: D:\\test CC NODE\\compact-guard-test\\recovery.txt",
    ].join("\n");
    expect(looksLikeFakeToolTrace(text, TOOLS)).toBe(true);
  });

  it("normal text is NOT a fake trace", () => {
    expect(looksLikeFakeToolTrace("The file was created successfully.", TOOLS)).toBe(false);
  });

  it("question text is NOT a fake trace", () => {
    expect(looksLikeFakeToolTrace("What should I do next?", TOOLS)).toBe(false);
  });

  it("code block is NOT a fake trace", () => {
    expect(looksLikeFakeToolTrace("```js\nconsole.log('hello');\n```", TOOLS)).toBe(false);
  });

  it("Bash: prefix is detected", () => {
    expect(looksLikeFakeToolTrace("Bash: npm test", TOOLS)).toBe(true);
  });

  it("no tools available → always false", () => {
    expect(looksLikeFakeToolTrace("Read file: foo.txt", [])).toBe(false);
  });

  it("very long text → false (>2000 chars)", () => {
    const long = "Read file: foo.txt\n".repeat(200);
    expect(looksLikeFakeToolTrace(long, TOOLS)).toBe(false);
  });

  it("empty text → false", () => {
    expect(looksLikeFakeToolTrace("", TOOLS)).toBe(false);
  });
});

describe("shouldRetry with fake tool traces", () => {
  const tools = ["Read", "Write", "Bash"];

  it("fake trace 'Read file: ...' + tools → retry", () => {
    expect(shouldRetry(true, null, "Read file: D:\\test\\foo.txt", "", tools)).toBe(true);
  });

  it("fake trace 'Write file: ...' + tools → retry", () => {
    expect(shouldRetry(true, null, "Write file: C:\\out.txt", "", tools)).toBe(true);
  });

  it("fake trace with real tool_call → no retry", () => {
    expect(shouldRetry(true, { name: "Read", arguments: {} }, "Read file: foo.txt", "", tools)).toBe(false);
  });

  it("normal text + tools → no retry", () => {
    expect(shouldRetry(true, null, "The task is complete.", "", tools)).toBe(false);
  });
});

describe("COMPLETION_GUARD_MAX_ATTEMPTS", () => {
  it("equals 3 (initial + 2 retries)", () => {
    expect(COMPLETION_GUARD_MAX_ATTEMPTS).toBe(3);
  });
});

describe("looksLikeFakeToolTrace — Tool: prefixed format", () => {
  const TOOLS = ["Read", "Write", "Bash", "Edit"];

  it("'Tool: Bash\\n{json}' is detected as fake trace", () => {
    const text = 'Tool: Bash\n{"command":"pwd"}';
    expect(looksLikeFakeToolTrace(text, TOOLS)).toBe(true);
  });

  it("'Tool: Read\\n{json}' is detected as fake trace", () => {
    const text = 'Tool: Read\n{"file_path":"D:\\\\test\\\\foo.txt"}';
    expect(looksLikeFakeToolTrace(text, TOOLS)).toBe(true);
  });

  it("'Tool: Write\\n{json}' is detected as fake trace", () => {
    const text = 'Tool: Write\n{"file_path":"out.txt","content":"hello"}';
    expect(looksLikeFakeToolTrace(text, TOOLS)).toBe(true);
  });

  it("unknown tool name → false", () => {
    const text = 'Tool: Deploy\n{"target":"prod"}';
    expect(looksLikeFakeToolTrace(text, TOOLS)).toBe(false);
  });

  it("normal text with 'Tool: Bash' in sentence → false", () => {
    expect(looksLikeFakeToolTrace("The Tool: Bash integration is available", TOOLS)).toBe(false);
  });

  it("Tool: prefix without JSON next line → false", () => {
    const text = 'Tool: Bash\nrun the command now';
    expect(looksLikeFakeToolTrace(text, TOOLS)).toBe(false);
  });

  it("case-insensitive Tool: prefix", () => {
    const text = 'tool: bash\n{"command":"ls"}';
    expect(looksLikeFakeToolTrace(text, TOOLS)).toBe(true);
  });
});

describe("shouldRetry with Tool: prefixed traces", () => {
  const tools = ["Read", "Write", "Bash"];

  it("Tool: Bash + JSON → retry", () => {
    const text = 'Tool: Bash\n{"command":"pwd"}';
    expect(shouldRetry(true, null, text, "", tools)).toBe(true);
  });

  it("Tool: Read + JSON → retry", () => {
    const text = 'Tool: Read\n{"file_path":"a.txt"}';
    expect(shouldRetry(true, null, text, "", tools)).toBe(true);
  });

  it("real tool_call → no retry", () => {
    const text = 'Tool: Bash\n{"command":"pwd"}';
    expect(shouldRetry(true, { name: "Bash", arguments: { command: "pwd" } }, text, "", tools)).toBe(false);
  });
});

describe("sanitizedToolInvocationText", () => {
  it("contains tool name", () => {
    const text = sanitizedToolInvocationText("Bash", "call_123");
    expect(text).toContain("Bash");
  });

  it("contains call_id", () => {
    const text = sanitizedToolInvocationText("Bash", "call_123");
    expect(text).toContain("call_123");
  });

  it("does NOT contain arguments", () => {
    const text = sanitizedToolInvocationText("Bash", "call_123");
    expect(text).not.toContain("arguments");
    expect(text).not.toContain("command");
  });

  it("contains DO NOT execute warning", () => {
    const text = sanitizedToolInvocationText("Read", "call_456");
    expect(text).toContain("DO NOT execute");
  });

  it("fallback for empty name", () => {
    const text = sanitizedToolInvocationText("", "call_1");
    expect(text).toContain("unknown");
  });

  it("fallback for empty callId", () => {
    const text = sanitizedToolInvocationText("Read", "");
    expect(text).toContain("unknown");
  });
});

describe("buildUpstreamPrompt — stale action replay prevention", () => {
  it("anthropic tool_use uses sanitized format without arguments", () => {
    const body = {
      system: "You are helpful.",
      messages: [
        { role: "user", content: [{ type: "text", text: "Read the file" }] },
        { role: "assistant", content: [
          { type: "tool_use", id: "call_abc", name: "Read", input: { file_path: "secret.txt" } },
        ]},
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "call_abc", content: "file contents" },
        ]},
      ],
    };
    const prompt = buildUpstreamPrompt(body, "anthropic", null);
    expect(prompt).toContain("DO NOT execute");
    expect(prompt).not.toContain("secret.txt");
    expect(prompt).not.toContain("file_path");
  });

  it("tool_result is preserved in upstream prompt", () => {
    const body = {
      messages: [
        { role: "assistant", content: [
          { type: "tool_use", id: "call_1", name: "Bash", input: { command: "rm -rf /" } },
        ]},
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "call_1", content: "done" },
        ]},
      ],
    };
    const prompt = buildUpstreamPrompt(body, "anthropic", null);
    expect(prompt).toContain("[Tool Result]");
    expect(prompt).toContain("done");
    expect(prompt).not.toContain("rm -rf /");
  });

  it("tool_result uses name from session map", () => {
    const body = {
      messages: [
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "call_99", content: "data" },
        ]},
      ],
    };
    const session = { toolCalls: new Map([["call_99", { name: "Read" }]]) };
    const prompt = buildUpstreamPrompt(body, "anthropic", session);
    expect(prompt).toContain("Read");
  });

  it("openai path uses historicalToolInvocationText with arguments", () => {
    const body = {
      messages: [
        { role: "assistant", content: "", tool_calls: [
          { id: "call_x", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } },
        ]},
        { role: "tool", tool_call_id: "call_x", content: "file.txt" },
      ],
    };
    const prompt = buildUpstreamPrompt(body, "openai", null);
    expect(prompt).toContain("Historical Action Record");
    expect(prompt).toContain("Bash");
  });
});

describe("DeepSeekClient prompt construction — stale action replay prevention", () => {
  it("excludes state.history while preserving the current user request", async () => {
    const originalFetch = globalThis.fetch;
    let completionPrompt = "";

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/v0/chat/create_pow_challenge")) {
        return new Response(JSON.stringify({
          data: {
            biz_data: {
              challenge: {
                target_path: "/api/v0/chat/completion",
                signature: "test-signature",
                salt: "test-salt",
                challenge: "test-challenge",
                algorithm: "DeepSeekHashV1",
                difficulty: 1,
                expire_at: Date.now() + 60_000,
              },
            },
          },
        }), { status: 200 });
      }
      if (url.endsWith("/api/v0/chat/completion")) {
        const payload = JSON.parse(String(init?.body)) as { prompt?: unknown };
        completionPrompt = String(payload.prompt ?? "");
        return new Response("", { status: 200 });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof globalThis.fetch;

    try {
      const client = new DeepSeekClient({
        baseUrl: "https://example.com",
        auth: { token: "test-token", cookie: "test-cookie" },
        sessionManager: {} as never,
        solver: {
          solve: async () => ({
            answer: 1,
            signature: "test-signature",
            algorithm: "DeepSeekHashV1",
            salt: "test-salt",
            challenge: "test-challenge",
          }),
        } as never,
        logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
        redactor: { addSecret: () => {}, redactText: (text: string) => text } as never,
        timeoutMs: 10_000,
        maxRetries: 0,
      });
      const state: UpstreamSessionState = {
        chatSessionId: "test-session",
        parentMessageId: null,
        history: [{
          role: "assistant",
          content: "STALE_DANGEROUS_ASSISTANT_ACTION: delete previous files",
        }],
        updatedAt: 0,
      };
      const request: CanonicalRequest = {
        model: "deepseek-reasoner",
        stream: false,
        system: "",
        messages: [{
          role: "user",
          parts: [{ type: "text", text: "CURRENT_USER_REQUEST: inspect the current file" }],
        }],
        tools: [],
      };

      await client.complete(request, state);

      expect(completionPrompt).toContain("CURRENT_USER_REQUEST: inspect the current file");
      expect(completionPrompt).not.toContain("STALE_DANGEROUS_ASSISTANT_ACTION");
      expect(completionPrompt).not.toContain("delete previous files");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("toolPrompt — priority rule (rule 11)", () => {
  const tools = [
    { name: "Read", description: "Read a file", inputSchema: { type: "object", properties: { file_path: { type: "string" } } } },
  ];

  it("contains PRIORITY RULE section", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toContain("PRIORITY RULE");
  });

  it("current user request is authoritative", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/CURRENT user request is authoritative/i);
  });

  it("historical context is context only", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/Historical conversation[\s\S]*?context only/i);
  });

  it("Historical Tool Actions mentioned as context only", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toContain("Historical Tool Actions");
  });

  it("NEVER repeat previous external action", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/NEVER repeat a previous external action/i);
  });

  it("exception for current tool_result cycle", () => {
    const prompt = buildToolPrompt(tools);
    expect(prompt).toMatch(/required to continue[\s\S]*?current tool_result cycle/i);
  });
});
