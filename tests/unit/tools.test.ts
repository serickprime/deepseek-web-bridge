import { describe, expect, it, vi } from "vitest";
import { parseToolInvocation, hasToolTag, createToolRetryPrompt, historicalToolInvocationText, sanitizedToolInvocationText, toolResultText, looksLikeToolIntentText, looksLikeFakeToolTrace, looksLikeEnvironmentDataRequest, looksLikeExternalActionRequest, looksLikeActionSuccessClaim, inspectCurrentToolCycle, inferToolObligations, inspectToolCallFromOutput, looksLikeMalformedToolIntent, matchObligationsToEvidence, toolCallFingerprint, isRepeatedFailedToolCall, isToolCallSemanticallyAdmissible, COMPLETION_GUARD_MAX_ATTEMPTS, buildUpstreamPrompt } from "../../src/tools/toolParser.js";
import type { CurrentToolCycleEvidence, ToolObligation } from "../../src/tools/toolParser.js";
import { buildToolPrompt, selectBridgeTools } from "../../src/tools/toolPrompt.js";
import { ToolRetryTracker } from "../../src/tools/toolRetry.js";
import { DeepSeekClient, shouldRetry, buildToolUseIdMap } from "../../src/deepseek/client.js";
import { CompletionHandler } from "../../src/api/handler.js";
import { normalizeAnthropic } from "../../src/api/normalizeAnthropic.js";
import { SessionStore } from "../../src/sessions/sessionStore.js";
import type { CanonicalMessage, CanonicalRequest } from "../../src/api/canonical.js";
import type { UpstreamSessionState } from "../../src/sessions/sessionStore.js";

const TOOLS = new Set(["Read", "Search", "get_weather", "calculate"]);
const D17_FILES = [
  { path: "d13-a.txt", marker: "D13-MARKER-A" },
  { path: "d13-b.txt", marker: "D13-MARKER-B" },
  { path: "d13-c.txt", marker: "D13-MARKER-C" },
];
const D17_LIVE_PROMPT = [
  "Выполни все действия последовательно и не пропускай ни одного.",
  `Создай ${D17_FILES[0]!.path} с содержимым "${D17_FILES[0]!.marker}".`,
  `Затем создай ${D17_FILES[1]!.path} с содержимым "${D17_FILES[1]!.marker}".`,
  `Затем создай ${D17_FILES[2]!.path} с содержимым "${D17_FILES[2]!.marker}".`,
  `Затем прочитай ${D17_FILES[0]!.path}.`,
  `Затем прочитай ${D17_FILES[1]!.path}.`,
  `Затем прочитай ${D17_FILES[2]!.path}.`,
].join("\n");

function d17FileCycleMessages(completedWrites = 3, completedReads = 3): CanonicalMessage[] {
  const messages: CanonicalMessage[] = [{ role: "user", parts: [{ type: "text", text: D17_LIVE_PROMPT }] }];
  for (const [index, file] of D17_FILES.slice(0, completedWrites).entries()) {
    const id = `d17-write-${index + 1}`;
    messages.push({
      role: "assistant",
      parts: [{ type: "tool_use", toolCall: { id, type: "function", name: "Write", arguments: { file_path: file.path, content: file.marker } } }],
    });
    messages.push({ role: "user", parts: [{ type: "tool_result", toolResult: { toolUseId: id, content: "ok", isError: false } }] });
  }
  for (const [index, file] of D17_FILES.slice(0, completedReads).entries()) {
    const id = `d17-read-${index + 1}`;
    messages.push({
      role: "assistant",
      parts: [{ type: "tool_use", toolCall: { id, type: "function", name: "Read", arguments: { file_path: file.path } } }],
    });
    messages.push({ role: "user", parts: [{ type: "tool_result", toolResult: { toolUseId: id, content: file.marker, isError: false } }] });
  }
  return messages;
}

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

  it("classifies an invalid escape inside an Edit envelope as malformed tool intent", () => {
    const malformed = String.raw`{"tool_call":{"name":"Edit","arguments":{"file_path":"server.js","old_string":"// Middleware\napp.use(cors());\app.use(express.json())","new_string":"app.use(cors());"}}}`;
    const inspection = inspectToolCallFromOutput({ content: malformed }, ["Edit"]);

    expect(looksLikeMalformedToolIntent(malformed, ["Edit"])).toBe(true);
    expect(inspection).toMatchObject({
      toolCall: null,
      reason: "extracted_json_invalid",
      source: "content",
      malformedToolIntent: true,
    });
  });

  it("parses a strict bare tool-call envelope", () => {
    const result = parseToolInvocation(
      '{"name":"Read","arguments":{"file_path":"a.txt"}}',
      TOOLS,
    );
    expect(result.toolCall).toMatchObject({ name: "Read", arguments: { file_path: "a.txt" } });
  });

  it("preserves correctly escaped Windows paths", () => {
    const result = parseToolInvocation(
      String.raw`{"tool_call":{"name":"Read","arguments":{"file_path":"C:\\Projects\\TaskFlow\\server.js"}}}`,
      TOOLS,
    );
    expect(result.toolCall?.arguments).toEqual({ file_path: String.raw`C:\Projects\TaskFlow\server.js` });
  });

  it("classifies a fenced tool marker with an unsupported envelope as malformed intent", () => {
    const output = '```json\n{"tool":"Edit","arguments":{"file_path":"server.js"}}\n```';
    const inspection = inspectToolCallFromOutput({ content: output }, ["Edit"]);

    expect(inspection).toMatchObject({
      toolCall: null,
      source: "content",
      malformedToolIntent: true,
    });
  });
});

describe("D12 nested array tool arguments", () => {
  const allowedNames = ["ArrayTool"];

  function inspectArguments(args: Record<string, unknown>, name = "ArrayTool") {
    return inspectToolCallFromOutput({
      content: JSON.stringify({ tool_call: { name, arguments: args } }),
      reasoning: "",
    }, allowedNames);
  }

  function request(): CanonicalRequest {
    return {
      model: "deepseek-v4-flash",
      stream: true,
      system: "",
      messages: [{ role: "user", parts: [{ type: "text", text: "Process these values with ArrayTool." }] }],
      tools: [{
        name: "ArrayTool",
        description: "Process nested values",
        inputSchema: {
          type: "object",
          properties: { values: { type: "array", items: {} } },
          required: ["values"],
        },
      }],
    };
  }

  function clientWithOutputs(outputs: string[]) {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    };
    logger.child.mockReturnValue(logger);
    const client = new DeepSeekClient({
      baseUrl: "https://example.invalid",
      auth: { token: "test-token", cookie: "test-cookie" },
      sessionManager: {} as never,
      solver: {} as never,
      logger: logger as never,
      redactor: { addSecret: () => {}, redactText: (text: string) => text } as never,
      timeoutMs: 1_000,
      maxRetries: 0,
    });
    const queue = [...outputs];
    const runCompletion = vi.fn(async () => ({
      content: queue.shift() ?? "",
      reasoning: "",
      candidateMessageId: null,
    }));
    Object.defineProperty(client, "runCompletion", { value: runCompletion });
    return { client, runCompletion, logger };
  }

  function state(): UpstreamSessionState {
    return { chatSessionId: "d12-session", parentMessageId: null, history: [], updatedAt: 0 };
  }

  it("accepts primitive arrays", () => {
    const args = { values: ["one", 2, true, null] };
    expect(inspectArguments(args).toolCall?.arguments).toEqual(args);
  });

  it("accepts empty arrays", () => {
    const args = { values: [] };
    expect(inspectArguments(args).toolCall?.arguments).toEqual(args);
  });

  it("accepts arrays of objects", () => {
    const args = { values: [{ id: 1 }, { id: 2 }] };
    expect(inspectArguments(args).toolCall?.arguments).toEqual(args);
  });

  it("accepts nested arrays", () => {
    const args = { values: [[1, 2], [3, 4]] };
    expect(inspectArguments(args).toolCall?.arguments).toEqual(args);
  });

  it("accepts objects containing arrays", () => {
    const args = { config: { modes: ["safe", "fast"] } };
    expect(inspectArguments(args).toolCall?.arguments).toEqual(args);
  });

  it("accepts arrays containing nested objects and arrays", () => {
    const args = { values: [{ steps: [[{ id: 1, labels: ["a", "b"] }]] }] };
    expect(inspectArguments(args).toolCall?.arguments).toEqual(args);
  });

  it("preserves exact mixed array arguments in CanonicalToolCall", () => {
    const args = {
      values: [
        { title: "UTF-8 — ёжик", options: [1, false, null] },
        ["nested", { enabled: true }],
      ],
    };
    const inspection = inspectArguments(args);

    expect(inspection).toMatchObject({ reason: "accepted", malformedToolIntent: false });
    expect(inspection.toolCall?.arguments).toEqual(args);
  });

  it("DeepSeekClient accepts an array-valued call without guard retry", async () => {
    const args = { values: [{ id: 1 }, { id: 2, tags: ["x", "y"] }] };
    const raw = JSON.stringify({ tool_call: { name: "ArrayTool", arguments: args } });
    const { client, runCompletion } = clientWithOutputs([raw]);

    const result = await client.complete(request(), state());

    expect(result.toolCall).toEqual({ name: "ArrayTool", args });
    expect(runCompletion).toHaveBeenCalledTimes(1);
  });

  it("CompletionHandler exposes exact arrays as Anthropic tool_use", async () => {
    const args = { values: [["one"], [{ id: 2, flags: [true, false] }]] };
    const raw = JSON.stringify({ tool_call: { name: "ArrayTool", arguments: args } });
    const { client, runCompletion } = clientWithOutputs([raw]);
    Object.defineProperty(client, "ensureSession", {
      value: vi.fn(async (session: UpstreamSessionState) => {
        session.chatSessionId = "d12-handler-session";
      }),
    });
    const lineage = {
      getUpstreamKey: vi.fn(),
      record: vi.fn(async () => {}),
    };
    const stream = {
      start: vi.fn(),
      push: vi.fn(),
      finish: vi.fn(),
      fail: vi.fn(),
    };
    const handler = new CompletionHandler({
      deepseek: client,
      sessionStore: new SessionStore(),
      lineage: lineage as never,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn().mockReturnThis(),
      } as never,
    });

    const result = await handler.run({
      protocol: "anthropic",
      request: request(),
      headers: {},
      body: {},
      stream: stream as never,
    });

    expect(result.result.toolCalls).toHaveLength(1);
    expect(result.result.toolCalls[0]?.arguments).toEqual(args);
    expect(stream.push).toHaveBeenCalledWith(expect.objectContaining({
      type: "tool_use",
      toolCall: expect.objectContaining({ name: "ArrayTool", arguments: args }),
    }));
    expect(runCompletion).toHaveBeenCalledTimes(1);
  });

  it("keeps root arguments arrays rejected", () => {
    const inspection = inspectToolCallFromOutput({
      content: '{"tool_call":{"name":"ArrayTool","arguments":[]}}',
      reasoning: "",
    }, allowedNames);

    expect(inspection.toolCall).toBeNull();
    expect(inspection.reason).toBe("arguments_not_object");
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects dangerous %s keys inside array objects",
    key => {
      const raw = `{"tool_call":{"name":"ArrayTool","arguments":{"values":[{"${key}":{"polluted":true}}]}}}`;
      const inspection = inspectToolCallFromOutput({ content: raw, reasoning: "" }, allowedNames);

      expect(inspection.toolCall).toBeNull();
      expect(inspection.reason).toBe("unsafe_arguments");
    },
  );

  it("rejects excessive mixed object and array nesting", () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 33; depth++) {
      nested = depth % 2 === 0 ? [nested] : { next: nested };
    }
    const inspection = inspectArguments({ value: nested });

    expect(inspection.toolCall).toBeNull();
    expect(inspection.reason).toBe("excessive_nesting");
  });

  it("keeps unknown tools rejected", () => {
    const inspection = inspectArguments({ values: [1, 2] }, "UnknownTool");

    expect(inspection.toolCall).toBeNull();
    expect(inspection.reason).toBe("tool_not_allowed");
  });

  it("keeps ordinary objects and primitives accepted", () => {
    const args = { path: "file.txt", count: 2, enabled: true, empty: null, nested: { mode: "safe" } };
    expect(inspectArguments(args).toolCall?.arguments).toEqual(args);
  });

  it.each([
    '{"tool_call":{"name":"ArrayTool","arguments":{"value":NaN}}}',
    '{"tool_call":{"name":"ArrayTool","arguments":{"fn":function(){}}}}',
  ])("keeps malformed special-value JSON rejected", raw => {
    const inspection = inspectToolCallFromOutput({ content: raw, reasoning: "" }, allowedNames);

    expect(inspection.toolCall).toBeNull();
    expect(inspection.reason).toBe("extracted_json_invalid");
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

describe("Claude Code Bridge tool availability", () => {
  const tools = [
    { name: "Artifact", description: "Create a claude.ai artifact", inputSchema: {} },
    { name: "Skill", description: "Load a skill", inputSchema: {} },
    { name: "Write", description: "Write a file", inputSchema: {} },
    { name: "Edit", description: "Edit a file", inputSchema: {} },
    { name: "Bash", description: "Run a command", inputSchema: {} },
  ];

  it("removes Artifact from the actual DeepSeek allowlist and prompt", () => {
    const selection = selectBridgeTools(tools);
    expect(selection.available.map(tool => tool.name)).toEqual(["Skill", "Write", "Edit", "Bash"]);
    expect(selection.unavailableNames).toEqual(["Artifact"]);
    const prompt = buildToolPrompt(tools);
    expect(prompt).not.toContain("- Artifact");
    expect(prompt).toContain("- Skill");
    expect(prompt).toContain("- Write");
    expect(prompt).toContain("- Edit");
    expect(prompt).toContain("- Bash");
  });

  it("explains the Artifact fallback only in the retry prompt", () => {
    const prompt = createToolRetryPrompt(["Skill", "Write", "Edit", "Bash"], {
      unavailableToolNames: ["Artifact"],
      failedToolNames: ["Artifact"],
      missingActionKinds: ["file_mutation", "launch"],
    });
    expect(prompt).toMatch(/Artifact is unavailable through this Bridge session/i);
    expect(prompt).toMatch(/did not create, save, launch, or open anything/i);
    expect(prompt).toMatch(/Write, Edit, or Bash/i);
    expect(prompt).not.toMatch(/Allowed tool names:.*Artifact/i);
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
    expect(text).toContain("status: success");
    expect(text).toContain("is_error: false");
    expect(text).toContain("file contents here");
  });

  it("preserves failed tool_result status for the upstream model", () => {
    const text = toolResultText("Artifact", "call_failed", "login required", true);
    expect(text).toContain("status: error");
    expect(text).toContain("is_error: true");
    expect(text).toContain("login required");
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
    expect(prompt).toContain("did NOT execute any tool");
    expect(prompt).toMatch(/must not invent or simulate cwd, files, directory listings, command output/i);
    expect(prompt).toMatch(/final answer is allowed only after.*real tool_result/i);
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

const DIRECTORY_LISTING_POSITIVES = [
  ["A", "что находится в данной директории?"],
  ["B", "что находится в данной дериктории?"],
  ["C", "что находится в текущей папке?"],
  ["D", "что лежит в этой директории?"],
  ["E", "какие файлы лежат здесь?"],
  ["F", "что есть в текущем каталоге?"],
  ["G", "покажи, что находится в папке"],
  ["H", "перечисли содержимое директории"],
  ["I", "what is in this directory?"],
  ["J", "what is inside the current folder?"],
  ["K", "what files are in this directory?"],
  ["L", "show what is inside this folder"],
] as const;

const DIRECTORY_LISTING_NEGATIVES = [
  "что такое директория?",
  "что обычно находится в директории?",
  "какие файлы бывают в проекте?",
  "расскажи про структуру проекта",
  "what is a directory?",
  "what can be found in a directory?",
  "explain folder structure",
  "где находится Москва?",
  "книга лежит на столе",
  "есть ли жизнь на Марсе?",
] as const;

describe("fabricated environment execution guard", () => {
  const tools = ["Bash", "Read", "Glob", "Grep"];

  it("detects fake pwd followed by Russian output", () => {
    const text = "Я проверю текущую рабочую директорию.\n\npwd\n\nВывод:\n\nD:/test CC NODE";
    expect(looksLikeFakeToolTrace(text, tools)).toBe(true);
  });

  it("detects fake ls -la followed by a shell listing", () => {
    const text = "ls -la\n\ntotal 0\ndrwxr-xr-x 1 user group 0 Aug 20 10:00 .";
    expect(looksLikeFakeToolTrace(text, tools)).toBe(true);
  });

  it("detects a claim that an invented cwd came from executing pwd", () => {
    const text = "Текущая рабочая директория:\nC:\\Users\\Mi\\Desktop\\project\n(Я получил этот путь, выполнив команду pwd в вашей среде.)";
    expect(looksLikeFakeToolTrace(text, tools)).toBe(true);
  });

  it("detects English fabricated execution and command output", () => {
    const text = "I ran pwd in your environment.\nCommand output:\nD:/invented/project";
    expect(looksLikeFakeToolTrace(text, tools)).toBe(true);
  });

  it("requires live evidence for current cwd requests", () => {
    expect(looksLikeEnvironmentDataRequest(
      "Проверь через реальный Bash pwd текущую рабочую директорию. Ответ только после tool_result.",
      tools,
    )).toBe(true);
  });

  it("requires live evidence for current directory listings", () => {
    expect(looksLikeEnvironmentDataRequest(
      "Покажи реальное содержимое текущей рабочей директории. Используй инструмент.",
      tools,
    )).toBe(true);
  });

  it.each(DIRECTORY_LISTING_POSITIVES)("requires fresh directory evidence for %s: %s", (_id, prompt) => {
    expect(looksLikeEnvironmentDataRequest(prompt, tools)).toBe(true);
    const evidence = inspectCurrentToolCycle([{
      role: "user",
      parts: [{ type: "text", text: prompt }],
    }], tools);
    expect(evidence.requiresEnvironmentToolResult).toBe(true);
    expect(evidence.isInformationalRequest).toBe(false);
  });

  it.each(DIRECTORY_LISTING_NEGATIVES)("keeps informational or unrelated text tool-free: %s", prompt => {
    expect(looksLikeEnvironmentDataRequest(prompt, tools)).toBe(false);
    const evidence = inspectCurrentToolCycle([{
      role: "user",
      parts: [{ type: "text", text: prompt }],
    }], tools);
    expect(evidence.requiresEnvironmentToolResult).toBe(false);
  });

  it("does not require directory evidence when no listing-capable tool is available", () => {
    expect(looksLikeEnvironmentDataRequest(
      "что находится в данной дериктории?",
      ["Read", "Write"],
    )).toBe(false);
  });

  it("requires live evidence for checking file existence", () => {
    expect(looksLikeEnvironmentDataRequest("Существует ли файл test.txt?", tools)).toBe(true);
    expect(looksLikeEnvironmentDataRequest("Does the file test.txt exist?", tools)).toBe(true);
  });

  it.each([
    "Покажи структуру проекта",
    "Прочитай AGENTS.md",
    "Покажи содержимое файла test.txt",
    "Выполни команду npm test",
  ])("requires live evidence for environment action: %s", prompt => {
    expect(looksLikeEnvironmentDataRequest(prompt, tools)).toBe(true);
  });

  it("allows an informational question about pwd without tools", () => {
    expect(looksLikeEnvironmentDataRequest("Что такое pwd?", tools)).toBe(false);
    expect(looksLikeEnvironmentDataRequest("Как работает ls -la?", tools)).toBe(false);
  });

  it("accepts a real Bash tool_call", () => {
    const evidence = inspectCurrentToolCycle([{
      role: "user",
      parts: [{ type: "text", text: "Проверь текущий cwd через pwd" }],
    }], tools);
    expect(shouldRetry(
      true,
      { name: "Bash", arguments: { command: "pwd" } },
      "",
      "",
      tools,
      evidence,
    )).toBe(false);
  });

  it("allows final text after a real current-cycle tool_result", () => {
    const evidence = inspectCurrentToolCycle([
      { role: "user", parts: [{ type: "text", text: "Проверь текущий cwd" }] },
      { role: "assistant", parts: [{
        type: "tool_use",
        toolCall: { id: "call_pwd", type: "function", name: "Bash", arguments: { command: "pwd" } },
      }] },
      { role: "user", parts: [{
        type: "tool_result",
        toolResult: { toolUseId: "call_pwd", content: "D:/test CC NODE" },
      }] },
    ], tools);
    expect(evidence.hasCurrentToolResult).toBe(true);
    expect(shouldRetry(true, null, "pwd\nВывод:\nD:/test CC NODE", "", tools, evidence)).toBe(false);
  });

  it("does not count a historical tool_result as evidence for a new turn", () => {
    const evidence = inspectCurrentToolCycle([
      { role: "user", parts: [{ type: "text", text: "Старый запрос" }] },
      { role: "assistant", parts: [{
        type: "tool_use",
        toolCall: { id: "call_old", type: "function", name: "Bash", arguments: { command: "pwd" } },
      }] },
      { role: "user", parts: [{
        type: "tool_result",
        toolResult: { toolUseId: "call_old", content: "C:/old" },
      }] },
      { role: "assistant", parts: [{ type: "text", text: "Старый ответ" }] },
      { role: "user", parts: [{ type: "text", text: "Проверь текущую рабочую директорию заново" }] },
    ], tools);
    expect(evidence.hasCurrentToolResult).toBe(false);
    expect(evidence.requiresEnvironmentToolResult).toBe(true);
  });
});

describe("D17 explicit command execution classification", () => {
  const tools = ["Bash", "Write", "Read"];
  const obligationKinds = (prompt: string) => inferToolObligations(prompt, tools).map(obligation => obligation.kind);

  it.each([
    ["explicit RU execute", "Выполни команду npm test"],
    ["explicit RU launch", "Запусти команду git status"],
    ["explicit EN execute", "Execute the command npm test"],
    ["explicit EN run", "Run the command git status"],
    ["direct recognizable CLI", "Выполни git status"],
    ["backticked CLI", "Выполни `git status`"],
    ["RU command label", "Команда: git status"],
    ["EN command label", "Command: npm test"],
    ["explicit Bash context", "Выполни через Bash git status"],
    ["explicit PowerShell context", "Execute in PowerShell Get-ChildItem"],
    ["explicit terminal context", "Run with the terminal git status"],
  ])("requires command evidence for %s", (_name, prompt) => {
    expect(looksLikeEnvironmentDataRequest(prompt, tools)).toBe(true);
    expect(obligationKinds(prompt)).toContain("command_execution");
  });

  it.each([
    ["Выполни все действия последовательно", false, []],
    ["Выполни задачу", false, []],
    ["Выполни изменения в трёх файлах", false, ["file_mutation"]],
    ["Выполни чтение этих файлов", false, []],
    ["Выполни следующие шаги: создай A.txt, прочитай B.txt", true, ["file_mutation", "file_verification"]],
    ["Выполни изменения в `file.txt`", false, ["file_mutation"]],
  ] as const)("does not infer a shell command from generic action wording: %s", (prompt, environmentExpected, expectedKinds) => {
    const kinds = obligationKinds(prompt);
    expect(kinds).not.toContain("command_execution");
    expect(kinds.filter(kind => kind === "file_mutation" || kind === "file_verification"))
      .toEqual([...expectedKinds]);
    expect(looksLikeEnvironmentDataRequest(prompt, tools)).toBe(environmentExpected);
  });

  it("keeps exactly the six requested D13 live obligations without command execution", () => {
    expect(inferToolObligations(D17_LIVE_PROMPT, tools).map(obligation => obligation.id)).toEqual([
      "file_mutation#1",
      "file_mutation#2",
      "file_mutation#3",
      "file_verification#1",
      "file_verification#2",
      "file_verification#3",
    ]);
  });

  it("accepts final text after all three Write and three Read results", () => {
    const evidence = inspectCurrentToolCycle(d17FileCycleMessages(), tools);
    expect(evidence.missingObligations).toEqual([]);
    expect(evidence.requiresActionToolResult).toBe(false);
    expect(shouldRetry(true, null, "Все три файла созданы и проверены.", "", tools, evidence)).toBe(false);
  });

  it("still blocks final text when file evidence is partial", () => {
    const evidence = inspectCurrentToolCycle(d17FileCycleMessages(2, 2), tools);
    expect(evidence.missingObligations.map(obligation => obligation.id)).toEqual([
      "file_mutation#3",
      "file_verification#3",
    ]);
    expect(shouldRetry(true, null, "Все действия выполнены.", "", tools, evidence)).toBe(true);
  });

  it("requires and accepts successful current-cycle evidence for an explicit command", () => {
    const missing = inspectCurrentToolCycle([{
      role: "user",
      parts: [{ type: "text", text: "Выполни git status" }],
    }], tools);
    expect(missing.missingActionKinds).toEqual(["command_execution"]);

    const completed = inspectCurrentToolCycle([
      { role: "user", parts: [{ type: "text", text: "Выполни git status" }] },
      { role: "assistant", parts: [{ type: "tool_use", toolCall: { id: "cmd", type: "function", name: "Bash", arguments: { command: "git status" } } }] },
      { role: "user", parts: [{ type: "tool_result", toolResult: { toolUseId: "cmd", content: "clean", isError: false } }] },
    ], tools);
    expect(completed.missingActionKinds).toEqual([]);
  });

  it("does not accept failed or historical Bash evidence for an explicit command", () => {
    const failed = inspectCurrentToolCycle([
      { role: "user", parts: [{ type: "text", text: "Выполни git status" }] },
      { role: "assistant", parts: [{ type: "tool_use", toolCall: { id: "failed", type: "function", name: "Bash", arguments: { command: "git status" } } }] },
      { role: "user", parts: [{ type: "tool_result", toolResult: { toolUseId: "failed", content: "failed", isError: true } }] },
    ], tools);
    expect(failed.missingActionKinds).toEqual(["command_execution"]);

    const historical = inspectCurrentToolCycle([
      { role: "user", parts: [{ type: "text", text: "Выполни старую команду git status" }] },
      { role: "assistant", parts: [{ type: "tool_use", toolCall: { id: "old", type: "function", name: "Bash", arguments: { command: "git status" } } }] },
      { role: "user", parts: [{ type: "tool_result", toolResult: { toolUseId: "old", content: "clean", isError: false } }] },
      { role: "assistant", parts: [{ type: "text", text: "Старый ответ" }] },
      { role: "user", parts: [{ type: "text", text: "Выполни git status" }] },
    ], tools);
    expect(historical.missingActionKinds).toEqual(["command_execution"]);
  });
});

describe("D20 explicit command payload classification", () => {
  const tools = ["Bash", "Write", "Edit", "Read"];
  const r3Prompt = "С помощью Bash выполни команду `node -e \"process.stdout.write('R3-BASH-731')\"` и только после успешного выполнения ответь R3-BASH-OK.";
  const kinds = (prompt: string) => inferToolObligations(prompt, tools).map(obligation => obligation.kind);

  it("infers only command execution for the exact R3-D prompt", () => {
    expect(kinds(r3Prompt)).toEqual(["command_execution"]);
  });

  it("does not treat stdout.write inside an explicit Bash payload as file mutation", () => {
    expect(kinds("С помощью Bash выполни `node -e \"process.stdout.write('X')\"`")).toEqual(["command_execution"]);
  });

  it("keeps console.log Bash code command-only", () => {
    expect(kinds("С помощью Bash выполни `node -e \"console.log('X')\"`")).toEqual(["command_execution"]);
  });

  it.each(["read", "write", "edit"])("does not infer file obligations from %s inside command code", token => {
    expect(kinds(`С помощью Bash выполни \`node -e \"object.${token}('X')\"\``)).toEqual(["command_execution"]);
  });

  it("does not infer file verification from fs.readFileSync with a file target inside Bash", () => {
    expect(kinds("С помощью Bash выполни `node -e \"fs.readFileSync('a.txt')\"`")).toEqual(["command_execution"]);
  });

  it.each(["readFile", "read", "readText"])("does not infer verification from command-local %s with a file target", token => {
    expect(kinds(`С помощью Bash выполни \`node -e \"reader.${token}('a.txt')\"\``)).toEqual(["command_execution"]);
  });

  it("recognizes a backticked echo command through the explicit Bash envelope", () => {
    expect(kinds("С помощью Bash выполни `echo X`")).toEqual(["command_execution"]);
  });

  it("keeps ordinary backticked file content visible outside a command envelope", () => {
    expect(kinds("Создай файл a.txt с содержимым `write`")).toEqual(["file_mutation"]);
  });

  it("keeps a pure redirection command command-only", () => {
    expect(kinds("Выполни команду `echo X > a.txt`")).toEqual(["command_execution"]);
  });

  it("preserves explicit file mutation prose outside the Bash payload", () => {
    expect(kinds("Создай файл a.txt и затем с помощью Bash выполни `node script.js`")).toEqual([
      "file_mutation",
      "command_execution",
    ]);
  });

  it("keeps explicit verification prose outside the Bash payload visible", () => {
    const obligations = inferToolObligations(
      "Прочитай a.txt, затем с помощью Bash выполни `node script.js`",
      tools,
    );
    expect(obligations.map(obligation => obligation.kind)).toEqual([
      "command_execution",
      "file_verification",
    ]);
    expect(obligations.find(obligation => obligation.kind === "file_verification")?.argumentLiterals)
      .toContain("a.txt");
  });

  it("keeps only the outside verification target when the Bash payload reads another file", () => {
    const obligations = inferToolObligations(
      "Прочитай a.txt, затем с помощью Bash выполни `node -e \"fs.readFileSync('b.txt')\"`",
      tools,
    );
    expect(obligations.map(obligation => obligation.kind)).toEqual([
      "command_execution",
      "file_verification",
    ]);
    expect(obligations.find(obligation => obligation.kind === "file_verification")?.argumentLiterals)
      .toEqual(["a.txt"]);
  });

  it("accepts the final after one successful R3-D Bash result without guard retry", async () => {
    const messages: CanonicalMessage[] = [
      { role: "user", parts: [{ type: "text", text: r3Prompt }] },
      { role: "assistant", parts: [{
        type: "tool_use",
        toolCall: {
          id: "d20-bash",
          type: "function",
          name: "Bash",
          arguments: { command: "node -e \"process.stdout.write('R3-BASH-731')\"" },
        },
      }] },
      { role: "user", parts: [{
        type: "tool_result",
        toolResult: { toolUseId: "d20-bash", content: "R3-BASH-731", isError: false },
      }] },
    ];
    const evidence = inspectCurrentToolCycle(messages, tools);
    expect(evidence.requiredActionKinds).toEqual(["command_execution"]);
    expect(evidence.missingObligations).toEqual([]);
    expect(shouldRetry(true, null, "R3-BASH-OK", "", tools, evidence)).toBe(false);

    const client = new DeepSeekClient({
      baseUrl: "https://example.com",
      auth: { token: "test-token", cookie: "test-cookie" },
      sessionManager: {} as never,
      solver: {} as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
      redactor: { addSecret: () => {}, redactText: (text: string) => text } as never,
      timeoutMs: 10_000,
      maxRetries: 0,
    });
    const runCompletion = vi.fn(async () => ({
      content: "R3-BASH-OK",
      reasoning: "",
      candidateMessageId: null,
    }));
    Object.defineProperty(client, "runCompletion", { value: runCompletion });
    const response = await client.complete({
      model: "deepseek-v4-flash",
      stream: false,
      system: "",
      messages,
      tools: [
        { name: "Bash", description: "Run a command", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
        { name: "Write", description: "Write a file", inputSchema: { type: "object", properties: { file_path: { type: "string" } } } },
        { name: "Edit", description: "Edit a file", inputSchema: { type: "object", properties: { file_path: { type: "string" } } } },
        { name: "Read", description: "Read a file", inputSchema: { type: "object", properties: { file_path: { type: "string" } } } },
      ],
    }, {
      chatSessionId: "d20-session",
      parentMessageId: null,
      history: [],
      updatedAt: 0,
    });
    expect(response.content).toBe("R3-BASH-OK");
    expect(response.toolCall).toBeUndefined();
    expect(runCompletion).toHaveBeenCalledTimes(1);
  });
});

describe("external action completion integrity", () => {
  const tools = ["Skill", "Write", "Edit", "Bash"];

  function cycle(
    prompt: string,
    calls: Array<{ id: string; name: string; arguments: Record<string, unknown>; error?: boolean; result?: string }> = [],
  ): CanonicalMessage[] {
    const messages: CanonicalMessage[] = [{ role: "user", parts: [{ type: "text", text: prompt }] }];
    for (const call of calls) {
      messages.push({
        role: "assistant",
        parts: [{
          type: "tool_use",
          toolCall: { id: call.id, type: "function", name: call.name, arguments: call.arguments },
        }],
      });
      messages.push({
        role: "user",
        parts: [{
          type: "tool_result",
          toolResult: { toolUseId: call.id, content: call.result ?? "ok", isError: call.error },
        }],
      });
    }
    return messages;
  }

  it("detects create plus launch as two distinct required actions", () => {
    const prompt = "сделай небольшой красивый лендинг на произвольную тему и потом запусти его";
    expect(looksLikeExternalActionRequest(prompt, tools)).toBe(true);
    expect(inspectCurrentToolCycle(cycle(prompt), tools).requiredActionKinds).toEqual(["file_mutation", "launch"]);
  });

  it("treats an explicit command as execution rather than a program launch", () => {
    const evidence = inspectCurrentToolCycle(cycle("запусти команду echo ok"), tools);
    expect(evidence.requiredActionKinds).toEqual(["command_execution"]);
  });

  it.each([
    "как создать файл?",
    "что делает Bash?",
    "как запустить HTML?",
    "что такое Artifact?",
  ])("does not require a tool for informational question: %s", prompt => {
    expect(looksLikeExternalActionRequest(prompt, tools)).toBe(false);
    expect(inspectCurrentToolCycle(cycle(prompt), tools).requiresActionToolResult).toBe(false);
  });

  it("rejects text-only success for create index.html", () => {
    const evidence = inspectCurrentToolCycle(cycle("создай index.html"), tools);
    expect(evidence.missingActionKinds).toEqual(["file_mutation"]);
    expect(shouldRetry(true, null, "Готово, index.html создан.", "", tools, evidence)).toBe(true);
  });

  it("allows final text after a successful Write result", () => {
    const evidence = inspectCurrentToolCycle(cycle("создай index.html", [{
      id: "call_write", name: "Write", arguments: { file_path: "index.html", content: "<html></html>" },
    }]), tools);
    expect(evidence.fulfilledActionKinds).toContain("file_mutation");
    expect(evidence.requiresActionToolResult).toBe(false);
    expect(shouldRetry(true, null, "index.html создан.", "", tools, evidence)).toBe(false);
  });

  it("accepts successful Bash redirection as real file mutation evidence", () => {
    const evidence = inspectCurrentToolCycle(cycle("создай index.html", [{
      id: "call_bash_write", name: "Bash", arguments: { command: "cat > index.html <<'EOF'\n<html></html>\nEOF" },
    }]), tools);
    expect(evidence.fulfilledActionKinds).toContain("file_mutation");
    expect(evidence.missingActionKinds).toEqual([]);
  });

  it("does not count an Artifact error as completing create or launch", () => {
    const prompt = "сделай лендинг и потом запусти его";
    const evidence = inspectCurrentToolCycle(cycle(prompt, [{
      id: "call_artifact",
      name: "Artifact",
      arguments: { type: "html" },
      error: true,
      result: "Artifacts need a claude.ai login",
    }]), tools);
    expect(evidence.hasFailedCurrentToolResult).toBe(true);
    expect(evidence.hasSuccessfulCurrentToolResult).toBe(false);
    expect(evidence.hasUnavailableToolFailure).toBe(true);
    expect(evidence.missingActionKinds).toEqual(["file_mutation", "launch"]);
    expect(shouldRetry(true, null, "Создал лендинг, сохранил index.html и открыл его.", "", tools, evidence)).toBe(true);
  });

  it("forbids a success final after a failed Bash result", () => {
    const evidence = inspectCurrentToolCycle(cycle("запусти сайт", [{
      id: "call_failed", name: "Bash", arguments: { command: "npm run dev" }, error: true, result: "command failed",
    }]), tools);
    expect(evidence.fulfilledActionKinds).not.toContain("launch");
    expect(shouldRetry(true, null, "Готово, сайт запущен.", "", tools, evidence)).toBe(true);
    expect(shouldRetry(true, null, "Запуск завершился с ошибкой; сайт не был запущен.", "", tools, evidence)).toBe(false);
  });

  it("requires a real execution result before claiming a site was launched", () => {
    const missing = inspectCurrentToolCycle(cycle("запусти сайт"), tools);
    expect(missing.missingActionKinds).toEqual(["launch"]);
    expect(shouldRetry(true, null, "Сайт открыт в браузере.", "", tools, missing)).toBe(true);

    const completed = inspectCurrentToolCycle(cycle("запусти сайт", [{
      id: "call_server", name: "Bash", arguments: { command: "python -m http.server 8123" }, result: "Serving HTTP" ,
    }]), tools);
    expect(completed.fulfilledActionKinds).toContain("launch");
    expect(shouldRetry(true, null, "Сайт запущен.", "", tools, completed)).toBe(false);
  });

  it("does not allow a successful Write result to stand in for a requested launch", () => {
    const evidence = inspectCurrentToolCycle(cycle("создай index.html и запусти сайт", [{
      id: "call_write", name: "Write", arguments: { file_path: "index.html", content: "ok" },
    }]), tools);
    expect(evidence.fulfilledActionKinds).toContain("file_mutation");
    expect(evidence.missingActionKinds).toEqual(["launch"]);
    expect(shouldRetry(true, null, "Готово: файл создан и сайт запущен.", "", tools, evidence)).toBe(true);
  });

  it("allows final only after both create and launch have successful results", () => {
    const evidence = inspectCurrentToolCycle(cycle("создай index.html и запусти сайт", [
      { id: "call_write", name: "Write", arguments: { file_path: "index.html", content: "ok" } },
      { id: "call_server", name: "Bash", arguments: { command: "python -m http.server 8123" }, result: "Serving HTTP" },
    ]), tools);
    expect(evidence.missingActionKinds).toEqual([]);
    expect(shouldRetry(true, null, "Готово: файл создан и сайт запущен.", "", tools, evidence)).toBe(false);
  });

  it("does not use a historical successful result as current action evidence", () => {
    const messages = cycle("старый запрос: создай old.html", [{
      id: "call_old", name: "Write", arguments: { file_path: "old.html", content: "old" },
    }]);
    messages.push({ role: "assistant", parts: [{ type: "text", text: "Старый ответ" }] });
    messages.push({ role: "user", parts: [{ type: "text", text: "создай index.html" }] });
    const evidence = inspectCurrentToolCycle(messages, tools);
    expect(evidence.hasCurrentToolResult).toBe(false);
    expect(evidence.missingActionKinds).toEqual(["file_mutation"]);
  });

  const exactTitle = "Проверка UTF-8 — ёжик №482";
  const exactDescription = "Съешь ещё этих мягких французских булок";
  const semanticPrompt = `создай задачу с названием "${exactTitle}" и описанием "${exactDescription}"`;
  const exactPostCommand = `node -e "fetch('http://127.0.0.1:3000/api/tasks', {method:'POST', body: JSON.stringify({title:'${exactTitle}', description:'${exactDescription}'})})"`;

  it("requires exact Unicode title and description in successful mutation arguments", () => {
    const obligations = inferToolObligations(semanticPrompt, tools);
    expect(obligations.find(obligation => obligation.kind === "data_mutation")).toMatchObject({
      argumentLiterals: [exactTitle, exactDescription],
    });

    const evidence = inspectCurrentToolCycle(cycle(semanticPrompt, [{
      id: "call_post",
      name: "Bash",
      arguments: { command: exactPostCommand },
      result: JSON.stringify({ title: exactTitle, description: exactDescription }),
    }]), tools);
    expect(evidence.fulfilledObligationIds).toContain("data_mutation");
    expect(evidence.missingExactLiterals).toEqual([]);
  });

  it("does not fulfill exact-value mutation with a weaker value", () => {
    const evidence = inspectCurrentToolCycle(cycle(semanticPrompt, [{
      id: "call_wrong_post",
      name: "Bash",
      arguments: { command: "node -e \"fetch('http://127.0.0.1:3000/api/tasks', {method:'POST', body: JSON.stringify({title:'LIVE'})})\"" },
      result: '{"title":"LIVE"}',
    }]), tools);
    expect(evidence.fulfilledObligationIds).not.toContain("data_mutation");
    expect(evidence.missingExactLiterals).toEqual([exactTitle, exactDescription]);
    expect(shouldRetry(true, null, "Готово, задача создана.", "", tools, evidence)).toBe(true);
  });

  it("does not fulfill a mutation when the application returns a structured error", () => {
    const evidence = inspectCurrentToolCycle(cycle(semanticPrompt, [{
      id: "call_rejected_post",
      name: "Bash",
      arguments: { command: exactPostCommand },
      result: '{"error":"Title is required"}',
    }]), tools);
    expect(evidence.fulfilledObligationIds).not.toContain("data_mutation");
    expect(evidence.missingActionKinds).toEqual(["data_mutation"]);
  });

  it("requires a separate API verification result with exact values", () => {
    const prompt = `${semanticPrompt}; проверь результат через API`;
    const postOnly = inspectCurrentToolCycle(cycle(prompt, [{
      id: "call_post",
      name: "Bash",
      arguments: { command: exactPostCommand },
      result: JSON.stringify({ title: exactTitle, description: exactDescription }),
    }]), tools);
    expect(postOnly.fulfilledObligationIds).toContain("data_mutation");
    expect(postOnly.missingActionKinds).toContain("api_verification");
    expect(shouldRetry(true, null, "Задача создана и всё проверено.", "", tools, postOnly)).toBe(true);

    const verified = inspectCurrentToolCycle(cycle(prompt, [
      { id: "call_post", name: "Bash", arguments: { command: exactPostCommand }, result: "created" },
      {
        id: "call_get",
        name: "Bash",
        arguments: { command: "node -e \"fetch('http://127.0.0.1:3000/api/tasks').then(r => r.text()).then(console.log)\"" },
        result: JSON.stringify({ title: exactTitle, description: exactDescription }),
      },
    ]), tools);
    expect(verified.fulfilledObligationIds).toEqual(expect.arrayContaining(["data_mutation", "api_verification"]));
    expect(verified.missingActionKinds).toEqual([]);
  });

  it("does not accept an API value that merely contains the requested exact literal", () => {
    const prompt = `${semanticPrompt}; проверь результат через API`;
    const evidence = inspectCurrentToolCycle(cycle(prompt, [
      { id: "call_post", name: "Bash", arguments: { command: exactPostCommand }, result: "created" },
      {
        id: "call_get",
        name: "Bash",
        arguments: { command: "curl http://127.0.0.1:3000/api/tasks" },
        result: JSON.stringify({ title: `${exactTitle} extra`, description: exactDescription }),
      },
    ]), tools);
    expect(evidence.fulfilledObligationIds).toContain("data_mutation");
    expect(evidence.fulfilledObligationIds).not.toContain("api_verification");
    expect(evidence.missingExactLiterals).toEqual([exactTitle, exactDescription]);
  });

  it("requires storage verification through Read or file-reading Bash evidence", () => {
    const prompt = `${semanticPrompt}; проверь файл хранения data/tasks.json`;
    const withoutRead = inspectCurrentToolCycle(cycle(prompt, [{
      id: "call_post", name: "Bash", arguments: { command: exactPostCommand }, result: "created",
    }]), tools);
    expect(withoutRead.missingActionKinds).toContain("file_verification");

    const withRead = inspectCurrentToolCycle(cycle(prompt, [
      { id: "call_post", name: "Bash", arguments: { command: exactPostCommand }, result: "created" },
      {
        id: "call_read",
        name: "Read",
        arguments: { file_path: "data/tasks.json" },
        result: JSON.stringify({ title: exactTitle, description: exactDescription }),
      },
    ]), tools);
    expect(withRead.fulfilledObligationIds).toContain("file_verification");
    expect(withRead.missingActionKinds).toEqual([]);
  });

  it("does not fulfill file verification with a not-found result masked as success", () => {
    const prompt = "проверь файл хранения data/tasks.json";
    const evidence = inspectCurrentToolCycle(cycle(prompt, [{
      id: "call_missing",
      name: "Bash",
      arguments: { command: 'cat data/tasks.json || echo "File not found"' },
      result: "File not found",
    }]), tools);
    expect(evidence.missingActionKinds).toEqual(["file_verification"]);
  });

  it("does not fulfill server verification with a masked connection failure", () => {
    const prompt = "убедись, что server отвечает";
    const evidence = inspectCurrentToolCycle(cycle(prompt, [{
      id: "call_health",
      name: "Bash",
      arguments: { command: 'curl http://localhost:3000 || echo "Server not responding"' },
      result: "Server not responding",
    }]), tools);
    expect(evidence.missingActionKinds).toEqual(["server_verification"]);
  });

  it("keeps test execution and launch as separate obligations", () => {
    const prompt = "запусти Jest и запусти приложение";
    const tested = inspectCurrentToolCycle(cycle(prompt, [{
      id: "call_test", name: "Bash", arguments: { command: "npx jest" }, result: "13 passed",
    }]), tools);
    expect(tested.fulfilledObligationIds).toContain("test_execution");
    expect(tested.missingActionKinds).toContain("launch");
    expect(shouldRetry(true, null, "Тесты прошли, приложение запущено.", "", tools, tested)).toBe(true);
  });

  it("does not treat a Jest version probe as test execution", () => {
    const prompt = "запусти Jest";
    const evidence = inspectCurrentToolCycle(cycle(prompt, [{
      id: "call_version",
      name: "Bash",
      arguments: { command: "npm test -- --version" },
      result: "29.7.0",
    }]), tools);
    expect(evidence.fulfilledObligationIds).not.toContain("test_execution");
    expect(evidence.missingActionKinds).toEqual(["test_execution"]);
  });

  it("does not fulfill test execution when a successful transport contains failed Jest output", () => {
    const evidence = inspectCurrentToolCycle(cycle("run Jest", [{
      id: "call_test",
      name: "Bash",
      arguments: { command: "npm test | head -50" },
      result: "Test Suites: 2 failed, 1 passed, 3 total\nTests: 3 failed, 26 passed, 29 total",
    }]), tools);
    expect(evidence.fulfilledObligationIds).not.toContain("test_execution");
    expect(evidence.missingActionKinds).toEqual(["test_execution"]);
  });

  it("retries a promised continuation instead of returning it as a final answer", () => {
    const evidence = inspectCurrentToolCycle(cycle("run Jest and leave the server running", [{
      id: "call_test",
      name: "Bash",
      arguments: { command: "npm test" },
      result: "3 tests failed",
      error: true,
    }]), tools);
    expect(shouldRetry(
      true,
      null,
      "3 tests failed. Let me start the server and rerun the tests.",
      "",
      tools,
      evidence,
    )).toBe(true);
  });

  it("retries a raw XML tool marker after a failed multi-step action", () => {
    const prompt = "запусти Jest и запусти приложение";
    const evidence = inspectCurrentToolCycle(cycle(prompt, [{
      id: "call_test",
      name: "Bash",
      arguments: { command: "npm test" },
      result: "3 tests failed",
      error: true,
    }]), tools);
    const rawContinuation = "Jest failed, so I will continue with the remaining work.\n<tool_calls><invoke name=\"Bash\"><parameter name=\"command\">npm test -- --runInBand</parameter></invoke></tool_calls>";
    expect(shouldRetry(true, null, rawContinuation, "", tools, evidence)).toBe(true);
  });

  it("does not let a successful Edit close a multi-step request", () => {
    const prompt = "измени server.js, проверь через API, проверь файл хранения data/tasks.json, запусти тесты и оставь приложение работающим";
    const evidence = inspectCurrentToolCycle(cycle(prompt, [{
      id: "call_edit", name: "Edit", arguments: { file_path: "server.js" }, result: "updated",
    }]), tools);
    expect(evidence.fulfilledObligationIds).toContain("file_mutation");
    expect(evidence.missingActionKinds).toEqual(expect.arrayContaining([
      "api_verification",
      "file_verification",
      "test_execution",
      "server_verification",
    ]));
  });

  it("retry prompt names only missing obligations and preserves completed evidence", () => {
    const prompt = `${semanticPrompt}; проверь результат через API`;
    const evidence = inspectCurrentToolCycle(cycle(prompt, [{
      id: "call_post", name: "Bash", arguments: { command: exactPostCommand }, result: "created",
    }]), tools);
    const fulfilled = evidence.obligations
      .filter(obligation => evidence.fulfilledObligationIds.includes(obligation.id))
      .map(obligation => obligation.description);
    const retry = createToolRetryPrompt(tools, {
      missingObligations: evidence.missingObligations.map(obligation => obligation.description),
      fulfilledObligations: fulfilled,
    });
    expect(retry).toContain("verify the result through the API");
    expect(retry).toContain("Already verified requirements");
    expect(retry).toContain("Do not repeat already verified steps");
  });

  it("distinguishes Claude task tracking from an application data mutation", () => {
    const evidence = inspectCurrentToolCycle(cycle(semanticPrompt), tools);
    const retry = createToolRetryPrompt(tools, {
      missingActionKinds: evidence.missingActionKinds,
      missingObligations: evidence.missingObligations.map(obligation => obligation.description),
    });
    expect(retry).toContain("TaskCreate and TaskUpdate only manage Claude's internal task list");
  });

  it("does not apply historical obligation evidence to the current request", () => {
    const messages = cycle(semanticPrompt, [{
      id: "call_old_post", name: "Bash", arguments: { command: exactPostCommand }, result: "created",
    }]);
    messages.push({ role: "assistant", parts: [{ type: "text", text: "Старая задача завершена" }] });
    messages.push({ role: "user", parts: [{ type: "text", text: "запусти тесты" }] });
    const evidence = inspectCurrentToolCycle(messages, tools);
    expect(evidence.requiredActionKinds).toEqual(["test_execution"]);
    expect(evidence.fulfilledObligationIds).toEqual([]);
  });

  it("does not let a standalone Claude system-reminder replace the current user obligations", () => {
    const messages = cycle(semanticPrompt);
    messages.push({
      role: "user",
      parts: [{
        type: "text",
        text: "<system-reminder>Remember to inspect files and run tests when appropriate.</system-reminder>",
      }],
    });
    const evidence = inspectCurrentToolCycle(messages, tools);
    expect(evidence.currentUserText).toBe(semanticPrompt);
    expect(evidence.requiredActionKinds).toContain("data_mutation");
    expect(evidence.missingExactLiterals).toEqual([exactTitle, exactDescription]);
  });

  it("starts a new obligation set for a new user request", () => {
    const messages = cycle("запусти тесты", [{
      id: "call_test", name: "Bash", arguments: { command: "npm test" }, result: "passed",
    }]);
    messages.push({ role: "assistant", parts: [{ type: "text", text: "Тесты прошли" }] });
    messages.push({ role: "user", parts: [{ type: "text", text: "оставь приложение работающим" }] });
    const evidence = inspectCurrentToolCycle(messages, tools);
    expect(evidence.requiredActionKinds).toEqual(["server_verification"]);
    expect(evidence.missingActionKinds).toEqual(["server_verification"]);
  });

  const finalTitle = "FINAL-CHECK — ёжик №731";
  const finalDescription = "Проверка единственного создания и полного цикла UTF-8";
  const finalStatePrompt = [
    "Создай ровно одну новую задачу:",
    "title:",
    finalTitle,
    "description:",
    finalDescription,
    "Затем проверь итог через API, проверь storage-файл data/tasks.json, запусти все тесты, проверь, что сервер отвечает, и оставь его работающим.",
  ].join("\n");
  const finalPost = `node -e "fetch('http://127.0.0.1:3000/api/tasks', {method:'POST', body: JSON.stringify({title:'${finalTitle}', description:'${finalDescription}'})})"`;
  const finalRecord = { title: finalTitle, description: finalDescription };

  it("invalidates API evidence when tests run after verification", () => {
    const evidence = inspectCurrentToolCycle(cycle(finalStatePrompt, [
      { id: "post", name: "Bash", arguments: { command: finalPost }, result: JSON.stringify(finalRecord) },
      { id: "api", name: "Bash", arguments: { command: "curl http://127.0.0.1:3000/api/tasks" }, result: JSON.stringify([finalRecord]) },
      { id: "tests", name: "Bash", arguments: { command: "npm test" }, result: "29 tests passed" },
    ]), tools);
    expect(evidence.fulfilledObligationIds).toContain("data_mutation");
    expect(evidence.fulfilledObligationIds).not.toContain("api_verification");
    expect(evidence.staleObligations.map(obligation => obligation.id)).toContain("api_verification");
  });

  it("invalidates storage evidence after a later Write", () => {
    const evidence = inspectCurrentToolCycle(cycle(finalStatePrompt, [
      { id: "post", name: "Bash", arguments: { command: finalPost }, result: "created" },
      { id: "storage", name: "Read", arguments: { file_path: "data/tasks.json" }, result: JSON.stringify([finalRecord]) },
      { id: "write", name: "Write", arguments: { file_path: "server.js", content: "updated" }, result: "updated" },
    ]), tools);
    expect(evidence.fulfilledObligationIds).not.toContain("file_verification");
    expect(evidence.staleObligations.map(obligation => obligation.id)).toContain("file_verification");
  });

  it("asks for re-verification without repeating a successful POST", () => {
    const evidence = inspectCurrentToolCycle(cycle(finalStatePrompt, [
      { id: "post", name: "Bash", arguments: { command: finalPost }, result: "created" },
      { id: "api", name: "Bash", arguments: { command: "curl http://127.0.0.1:3000/api/tasks" }, result: JSON.stringify([finalRecord]) },
      { id: "tests", name: "Bash", arguments: { command: "npm test" }, result: "29 tests passed" },
    ]), tools);
    const fulfilled = evidence.obligations
      .filter(obligation => evidence.fulfilledObligationIds.includes(obligation.id))
      .map(obligation => obligation.description);
    const retry = createToolRetryPrompt(tools, {
      missingObligations: evidence.missingObligations.map(obligation => obligation.description),
      fulfilledObligations: fulfilled,
      staleObligations: evidence.staleObligations.map(obligation => obligation.description),
    });
    expect(retry).toContain("Re-check the final state now with a fresh GET, Read, or health request");
    expect(retry).toContain("Do NOT repeat an already successful mutation or POST");
    expect(fulfilled).toContainEqual(expect.stringContaining("create or update the requested data"));
  });

  it("requires both API and storage verification again after tests", () => {
    const evidence = inspectCurrentToolCycle(cycle(finalStatePrompt, [
      { id: "post", name: "Bash", arguments: { command: finalPost }, result: "created" },
      { id: "api", name: "Bash", arguments: { command: "curl http://127.0.0.1:3000/api/tasks" }, result: JSON.stringify([finalRecord]) },
      { id: "storage", name: "Read", arguments: { file_path: "data/tasks.json" }, result: JSON.stringify([finalRecord]) },
      { id: "tests", name: "Bash", arguments: { command: "npm test" }, result: "29 tests passed" },
    ]), tools);
    expect(evidence.staleObligations.map(obligation => obligation.id)).toEqual(expect.arrayContaining([
      "api_verification",
      "file_verification",
    ]));
    expect(evidence.requiresActionToolResult).toBe(true);
  });

  it.each([
    { records: [] as typeof finalRecord[], expectedCount: 0, fulfilled: false },
    { records: [finalRecord], expectedCount: 1, fulfilled: true },
    { records: [finalRecord, finalRecord], expectedCount: 2, fulfilled: false },
  ])("enforces exactly one final API record when count is $expectedCount", ({ records, expectedCount, fulfilled }) => {
    const evidence = inspectCurrentToolCycle(cycle(finalStatePrompt, [
      { id: "post", name: "Bash", arguments: { command: finalPost }, result: "created" },
      { id: "api", name: "Bash", arguments: { command: "curl http://127.0.0.1:3000/api/tasks" }, result: JSON.stringify(records) },
    ]), tools);
    expect(evidence.fulfilledObligationIds.includes("api_verification")).toBe(fulfilled);
    if (fulfilled) {
      expect(evidence.cardinalityFailures).toEqual([]);
    } else {
      expect(evidence.cardinalityFailures).toContainEqual({
        obligationId: "api_verification",
        expectedCount: 1,
        observedCount: expectedCount,
      });
    }
  });

  it("does not invalidate final API evidence after an unrelated Read", () => {
    const evidence = inspectCurrentToolCycle(cycle(finalStatePrompt, [
      { id: "post", name: "Bash", arguments: { command: finalPost }, result: "created" },
      { id: "api", name: "Bash", arguments: { command: "curl http://127.0.0.1:3000/api/tasks" }, result: JSON.stringify([finalRecord]) },
      { id: "read", name: "Read", arguments: { file_path: "README.md" }, result: "documentation" },
    ]), tools);
    expect(evidence.fulfilledObligationIds).toContain("api_verification");
    expect(evidence.staleObligations).toEqual([]);
  });

  it("does not invalidate final evidence after an informational command", () => {
    const evidence = inspectCurrentToolCycle(cycle(finalStatePrompt, [
      { id: "post", name: "Bash", arguments: { command: finalPost }, result: "created" },
      { id: "api", name: "Bash", arguments: { command: "curl http://127.0.0.1:3000/api/tasks" }, result: JSON.stringify([finalRecord]) },
      { id: "pwd", name: "Bash", arguments: { command: "pwd" }, result: "/workspace" },
    ]), tools);
    expect(evidence.fulfilledObligationIds).toContain("api_verification");
  });

  it("requires a new health result after a server restart", () => {
    const stale = inspectCurrentToolCycle(cycle(finalStatePrompt, [
      { id: "health1", name: "Bash", arguments: { command: "curl http://127.0.0.1:3000/health" }, result: "HTTP 200" },
      { id: "restart", name: "Bash", arguments: { command: "npm start" }, result: "server listening" },
    ]), tools);
    expect(stale.fulfilledObligationIds).not.toContain("server_verification");
    expect(stale.staleObligations.map(obligation => obligation.id)).toContain("server_verification");

    const fresh = inspectCurrentToolCycle(cycle(finalStatePrompt, [
      { id: "health1", name: "Bash", arguments: { command: "curl http://127.0.0.1:3000/health" }, result: "HTTP 200" },
      { id: "restart", name: "Bash", arguments: { command: "npm start" }, result: "server listening" },
      { id: "health2", name: "Bash", arguments: { command: "curl http://127.0.0.1:3000/health" }, result: "HTTP 200" },
    ]), tools);
    expect(fresh.fulfilledObligationIds).toContain("server_verification");
  });

  it("allows final only after fresh postconditions follow every relevant mutation", () => {
    const evidence = inspectCurrentToolCycle(cycle(finalStatePrompt, [
      { id: "post", name: "Bash", arguments: { command: finalPost }, result: "created" },
      { id: "tests", name: "Bash", arguments: { command: "npm test" }, result: "29 tests passed" },
      { id: "server", name: "Bash", arguments: { command: "npm start" }, result: "server listening" },
      { id: "api", name: "Bash", arguments: { command: "curl http://127.0.0.1:3000/api/tasks" }, result: JSON.stringify([finalRecord]) },
      { id: "storage", name: "Read", arguments: { file_path: "data/tasks.json" }, result: JSON.stringify([finalRecord]) },
      { id: "health", name: "Bash", arguments: { command: "curl http://127.0.0.1:3000/health" }, result: "HTTP 200" },
    ]), tools);
    expect(evidence.missingObligations).toEqual([]);
    expect(evidence.staleObligations).toEqual([]);
    expect(evidence.cardinalityFailures).toEqual([]);
    expect(shouldRetry(true, null, "Задача завершена и финальное состояние проверено.", "", tools, evidence)).toBe(false);
  });

  it("does not create obligations for an informational request", () => {
    expect(inferToolObligations("как проверить API и запустить Jest?", tools)).toEqual([]);
    const evidence = inspectCurrentToolCycle(cycle("что означает title \"Проверка UTF-8 — ёжик №482\"?"), tools);
    expect(evidence.obligations).toEqual([]);
    expect(evidence.requiresActionToolResult).toBe(false);
  });

  it("recognizes success claims without treating negated failures as success", () => {
    expect(looksLikeActionSuccessClaim("Готово, файл создан и сайт запущен.")).toBe(true);
    expect(looksLikeActionSuccessClaim("Ошибка: файл не был создан, сайт не был запущен.")).toBe(false);
  });
});

describe("final-state tool flow regression", () => {
  const tools = ["Bash", "Read", "Write", "Edit"];
  const title = "FLOW-CHECK — ёжик №482";
  const description = "Съешь ещё этих мягких французских булок";
  const record = { title, description };
  const flowPrompt = [
    "Создай ровно одну новую задачу:",
    "title:",
    title,
    "description:",
    description,
    "Затем проверь итог через API, запиши отчёт в report.txt, проверь storage-файл data/tasks.json, запусти все тесты, подними сервер, проверь, что он отвечает, и снова проверь итог через API.",
  ].join("\n");
  const post = `node -e "fetch('http://127.0.0.1:3000/api/tasks', {method:'POST', body: JSON.stringify({title:'${title}', description:'${description}'})})"`;
  const getApi = "curl http://127.0.0.1:3000/api/tasks";

  function cycle(calls: Array<{ id: string; name: string; arguments: Record<string, unknown>; result?: string; error?: boolean }>): CanonicalMessage[] {
    const messages: CanonicalMessage[] = [{ role: "user", parts: [{ type: "text", text: flowPrompt }] }];
    for (const call of calls) {
      messages.push({
        role: "assistant",
        parts: [{ type: "tool_use", toolCall: { id: call.id, type: "function", name: call.name, arguments: call.arguments } }],
      });
      messages.push({
        role: "user",
        parts: [{ type: "tool_result", toolResult: { toolUseId: call.id, content: call.result ?? "ok", isError: call.error } }],
      });
    }
    return messages;
  }

  it("completes a sequential Bash → Write → Read → tests → launch → fresh verify flow without blocking the final", () => {
    const evidence = inspectCurrentToolCycle(cycle([
      { id: "post", name: "Bash", arguments: { command: post }, result: "created" },
      { id: "api1", name: "Bash", arguments: { command: getApi }, result: JSON.stringify([record]) },
      { id: "report", name: "Write", arguments: { file_path: "report.txt", content: "Отчёт по задаче готов." }, result: "File written" },
      { id: "tests", name: "Bash", arguments: { command: "npx jest" }, result: "29 tests passed" },
      { id: "storage", name: "Bash", arguments: { command: "cat report.txt data/tasks.json" }, result: JSON.stringify([record]) },
      { id: "server", name: "Bash", arguments: { command: "node server.js" }, result: "listening on 3000" },
      { id: "health", name: "Bash", arguments: { command: "curl http://127.0.0.1:3000/health" }, result: "HTTP 200" },
      { id: "api2", name: "Bash", arguments: { command: getApi }, result: JSON.stringify([record]) },
    ]), tools);
    expect(evidence.missingObligations).toEqual([]);
    expect(evidence.staleObligations).toEqual([]);
    expect(evidence.inconclusiveObligations).toEqual([]);
    expect(evidence.cardinalityFailures).toEqual([]);
    expect(shouldRetry(true, null, "Готово: задача создана, отчёт записан, тесты прошли, сервер работает.", "", tools, evidence)).toBe(false);
  });

  it("keeps exact count enforcement: one record fulfilled, two rejected", () => {
    const single = inspectCurrentToolCycle(cycle([
      { id: "post", name: "Bash", arguments: { command: post }, result: "created" },
      { id: "api", name: "Bash", arguments: { command: getApi }, result: JSON.stringify([record]) },
    ]), tools);
    expect(single.fulfilledObligationIds).toContain("api_verification");
    expect(single.cardinalityFailures).toEqual([]);

    const duplicate = inspectCurrentToolCycle(cycle([
      { id: "post", name: "Bash", arguments: { command: post }, result: "created" },
      { id: "api", name: "Bash", arguments: { command: getApi }, result: JSON.stringify([record, record]) },
    ]), tools);
    expect(duplicate.fulfilledObligationIds).not.toContain("api_verification");
    expect(duplicate.cardinalityFailures).toContainEqual({
      obligationId: "api_verification",
      expectedCount: 1,
      observedCount: 2,
    });
  });

  it("treats an unobservable count as inconclusive and demands deterministic re-verification", () => {
    const evidence = inspectCurrentToolCycle(cycle([
      { id: "post", name: "Bash", arguments: { command: post }, result: "created" },
      { id: "api", name: "Bash", arguments: { command: getApi }, result: `Задача найдена: ${title} / ${description}. Всего задач: 1.` },
    ]), tools);
    expect(evidence.fulfilledObligationIds).not.toContain("api_verification");
    expect(evidence.inconclusiveObligations.map(obligation => obligation.id)).toContain("api_verification");
    expect(evidence.cardinalityFailures).toEqual([]);

    const retry = createToolRetryPrompt(tools, {
      missingObligations: evidence.missingObligations.map(obligation => obligation.description),
      inconclusiveObligations: evidence.inconclusiveObligations.map(obligation => obligation.description),
    });
    expect(retry).toContain("could not be deterministically counted");
    expect(retry).toContain("Do NOT repeat an already successful mutation or POST");
  });

  it("excludes unrelated health output from cardinality counting", () => {
    const beforeFreshGet = inspectCurrentToolCycle(cycle([
      { id: "post", name: "Bash", arguments: { command: post }, result: "created" },
      { id: "api1", name: "Bash", arguments: { command: getApi }, result: JSON.stringify([record]) },
      { id: "tests", name: "Bash", arguments: { command: "npm test" }, result: "29 tests passed" },
      { id: "server", name: "Bash", arguments: { command: "node server.js" }, result: "listening" },
      { id: "health", name: "Bash", arguments: { command: "node -e \"fetch('http://127.0.0.1:3000/health').then(r=>console.log(r.status))\"" }, result: "200" },
    ]), tools);
    expect(beforeFreshGet.cardinalityFailures).toEqual([]);
    expect(beforeFreshGet.inconclusiveObligations).toEqual([]);
    expect(beforeFreshGet.fulfilledObligationIds).not.toContain("api_verification");

    const afterFreshGet = inspectCurrentToolCycle(cycle([
      { id: "post", name: "Bash", arguments: { command: post }, result: "created" },
      { id: "api1", name: "Bash", arguments: { command: getApi }, result: JSON.stringify([record]) },
      { id: "tests", name: "Bash", arguments: { command: "npm test" }, result: "29 tests passed" },
      { id: "server", name: "Bash", arguments: { command: "node server.js" }, result: "listening" },
      { id: "health", name: "Bash", arguments: { command: "node -e \"fetch('http://127.0.0.1:3000/health').then(r=>console.log(r.status))\"" }, result: "200" },
      { id: "api2", name: "Bash", arguments: { command: getApi }, result: JSON.stringify([record]) },
    ]), tools);
    expect(afterFreshGet.fulfilledObligationIds).toContain("api_verification");
    expect(afterFreshGet.cardinalityFailures).toEqual([]);
  });

  it("does not require API-record literals for an independent report Write", () => {
    const reportPrompt = [
      "Создай ровно одну новую задачу:",
      "title:",
      title,
      "description:",
      description,
      "Затем проверь итог через API и запиши отчёт в report.txt.",
    ].join("\n");
    const messages: CanonicalMessage[] = [{ role: "user", parts: [{ type: "text", text: reportPrompt }] }];
    for (const call of [
      { id: "post", name: "Bash", arguments: { command: post }, result: "created" },
      { id: "report", name: "Write", arguments: { file_path: "report.txt", content: "Отчёт по задаче готов." }, result: "File written" },
    ]) {
      messages.push({ role: "assistant", parts: [{ type: "tool_use", toolCall: { id: call.id, type: "function", name: call.name, arguments: call.arguments } }] });
      messages.push({ role: "user", parts: [{ type: "tool_result", toolResult: { toolUseId: call.id, content: call.result ?? "ok" } }] });
    }
    const evidence = inspectCurrentToolCycle(messages, tools);
    expect(evidence.fulfilledObligationIds).toContain("file_mutation");
    expect(evidence.fulfilledObligationIds).toContain("data_mutation");
  });

  it("still requires explicitly requested values when writing them into a file", () => {
    const notePrompt = "создай файл note.txt с названием «Заметка ёжик» и содержимым «AB-TEST-731»";
    function noteCycle(writeArgs: Record<string, unknown>): CanonicalMessage[] {
      return [{
        role: "user",
        parts: [{ type: "text", text: notePrompt }],
      }, {
        role: "assistant",
        parts: [{ type: "tool_use", toolCall: { id: "write", type: "function", name: "Write", arguments: writeArgs } }],
      }, {
        role: "user",
        parts: [{ type: "tool_result", toolResult: { toolUseId: "write", content: "File written" } }],
      }];
    }
    const exact = inspectCurrentToolCycle(noteCycle({
      file_path: "note.txt",
      content: "Заметка ёжик\nAB-TEST-731",
    }), tools);
    expect(exact.fulfilledObligationIds).toContain("file_mutation");

    const weaker = inspectCurrentToolCycle(noteCycle({
      file_path: "note.txt",
      content: "какая-то другая заметка",
    }), tools);
    expect(weaker.fulfilledObligationIds).not.toContain("file_mutation");
  });

  it("keeps stale verification blocking until fresh evidence arrives", () => {
    const evidence = inspectCurrentToolCycle(cycle([
      { id: "post", name: "Bash", arguments: { command: post }, result: "created" },
      { id: "api1", name: "Bash", arguments: { command: getApi }, result: JSON.stringify([record]) },
      { id: "tests", name: "Bash", arguments: { command: "npm test" }, result: "29 tests passed" },
    ]), tools);
    expect(evidence.staleObligations.map(obligation => obligation.id)).toContain("api_verification");
    expect(evidence.requiresActionToolResult).toBe(true);
    expect(shouldRetry(true, null, "Готово, всё проверено.", "", tools, evidence)).toBe(true);
  });

  it("blocks malformed tool intent while obligations are pending", () => {
    const evidence = inspectCurrentToolCycle(cycle([
      { id: "post", name: "Bash", arguments: { command: post }, result: "created" },
    ]), tools);
    expect(shouldRetry(true, null, "", "", tools, evidence, true)).toBe(true);
  });
});

describe("repeated failed tool call evidence", () => {
  const tools = ["Bash", "Read"];

  function toolCycle(
    error: boolean,
    nextUserText?: string,
  ): CanonicalMessage[] {
    const messages: CanonicalMessage[] = [
      { role: "user", parts: [{ type: "text", text: "Выполни команду false" }] },
      { role: "assistant", parts: [{
        type: "tool_use",
        toolCall: {
          id: "call_failed",
          type: "function",
          name: "Bash",
          arguments: { timeout: 1_000, command: "false" },
        },
      }] },
      { role: "user", parts: [{
        type: "tool_result",
        toolResult: { toolUseId: "call_failed", content: "exit code 1", isError: error },
      }] },
    ];
    if (nextUserText) {
      messages.push({ role: "assistant", parts: [{ type: "text", text: "Команда завершилась с ошибкой." }] });
      messages.push({ role: "user", parts: [{ type: "text", text: nextUserText }] });
    }
    return messages;
  }

  it("builds the same fingerprint regardless of JSON object key formatting", () => {
    expect(toolCallFingerprint("Bash", {
      timeout: 1_000,
      command: "false",
      options: { cwd: ".", env: { Z: "2", A: "1" } },
    })).toBe(toolCallFingerprint("Bash", {
      options: { env: { A: "1", Z: "2" }, cwd: "." },
      command: "false",
      timeout: 1_000,
    }));
  });

  it("ignores Bash description text that does not change the executed action", () => {
    expect(toolCallFingerprint("Bash", {
      command: "false",
      description: "Execute false command that always fails",
      timeout: 120_000,
    })).toBe(toolCallFingerprint("Bash", {
      timeout: 120_000,
      description: "Execute false command to verify it fails",
      command: "false",
    }));
  });

  it("blocks an identical failed Bash call with reordered JSON keys", () => {
    const evidence = inspectCurrentToolCycle(toolCycle(true), tools);
    const repeated = { name: "Bash", arguments: { command: "false", timeout: 1_000 } };
    expect(isRepeatedFailedToolCall(repeated, evidence)).toBe(true);
    expect(shouldRetry(true, repeated, "", "", tools, evidence)).toBe(true);
  });

  it("allows changed arguments after a failure", () => {
    const evidence = inspectCurrentToolCycle(toolCycle(true), tools);
    const changed = { name: "Bash", arguments: { command: "false --verbose", timeout: 1_000 } };
    expect(isRepeatedFailedToolCall(changed, evidence)).toBe(false);
    expect(shouldRetry(true, changed, "", "", tools, evidence)).toBe(false);
  });

  it("allows a different tool after a failed Bash call", () => {
    const evidence = inspectCurrentToolCycle(toolCycle(true), tools);
    const different = { name: "Read", arguments: { file_path: "error.log" } };
    expect(isRepeatedFailedToolCall(different, evidence)).toBe(false);
    expect(shouldRetry(true, different, "", "", tools, evidence)).toBe(false);
  });

  it("does not fingerprint successful tool results as failures", () => {
    const evidence = inspectCurrentToolCycle(toolCycle(false), tools);
    const same = { name: "Bash", arguments: { command: "false", timeout: 1_000 } };
    expect(evidence.failedToolFingerprints).toEqual([]);
    expect(isRepeatedFailedToolCall(same, evidence)).toBe(false);
  });

  it("does not carry a historical failed fingerprint into a new user request", () => {
    const evidence = inspectCurrentToolCycle(toolCycle(true, "Покажи текущую папку"), tools);
    const oldCall = { name: "Bash", arguments: { command: "false", timeout: 1_000 } };
    expect(evidence.failedToolFingerprints).toEqual([]);
    expect(isRepeatedFailedToolCall(oldCall, evidence)).toBe(false);
  });

  it("starts a new action cycle when the user explicitly asks to retry", () => {
    const evidence = inspectCurrentToolCycle(toolCycle(true, "Попробуй эту команду ещё раз"), tools);
    const retry = { name: "Bash", arguments: { command: "false", timeout: 1_000 } };
    expect(evidence.currentUserText).toBe("Попробуй эту команду ещё раз");
    expect(shouldRetry(true, retry, "", "", tools, evidence)).toBe(false);
  });
});

describe("DeepSeekClient environment completion guard", () => {
  const bashTool = {
    name: "Bash",
    description: "Run a shell command",
    inputSchema: { type: "object", properties: { command: { type: "string" } } },
  };
  const globTool = {
    name: "Glob",
    description: "List files by pattern",
    inputSchema: { type: "object", properties: { pattern: { type: "string" } } },
  };
  const listDirectoryTool = {
    name: "ListDirectory",
    description: "List a directory",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  };
  const readTool = {
    name: "Read",
    description: "Read a file",
    inputSchema: { type: "object", properties: { file_path: { type: "string" } } },
  };

  function request(
    messages: CanonicalMessage[],
    tools: CanonicalRequest["tools"] = [bashTool, globTool, listDirectoryTool],
  ): CanonicalRequest {
    return {
      model: "deepseek-reasoner",
      stream: false,
      system: "cwd: D:/test CC NODE",
      messages,
      tools,
    };
  }

  function state(): UpstreamSessionState {
    return { chatSessionId: "guard-session", parentMessageId: null, history: [], updatedAt: 0 };
  }

  function clientWithOutputs(outputs: Array<{ content: string; reasoning?: string }>) {
    const loggerWarn = vi.fn();
    const client = new DeepSeekClient({
      baseUrl: "https://example.com",
      auth: { token: "test-token", cookie: "test-cookie" },
      sessionManager: {} as never,
      solver: {} as never,
      logger: { info: () => {}, warn: loggerWarn, error: () => {} } as never,
      redactor: { addSecret: () => {}, redactText: (text: string) => text } as never,
      timeoutMs: 10_000,
      maxRetries: 0,
    });
    const queue = [...outputs];
    const runCompletion = vi.fn(async (_prompt: string, _state: UpstreamSessionState, _authGeneration: number) => {
      const output = queue.shift();
      if (!output) throw new Error("No mocked completion output left");
      return {
        content: output.content,
        reasoning: output.reasoning ?? "",
        parentMessageId: null,
      };
    });
    Object.defineProperty(client, "runCompletion", { value: runCompletion });
    return { client, runCompletion, loggerWarn };
  }

  it("rejects a plausible correct cwd when no real tool_result exists", async () => {
    const fake = "Текущая рабочая директория: D:/test CC NODE";
    const { client, runCompletion, loggerWarn } = clientWithOutputs([
      { content: fake },
      { content: fake },
      { content: fake },
    ]);

    await expect(client.complete(request([{
      role: "user",
      parts: [{ type: "text", text: "Проверь через Bash pwd текущую рабочую директорию" }],
    }]), state())).rejects.toMatchObject({ code: "TOOL_CALL_REQUIRED", status: 502 });
    expect(runCompletion).toHaveBeenCalledTimes(COMPLETION_GUARD_MAX_ATTEMPTS);
    expect(runCompletion.mock.calls[1]?.[0]).toMatch(/did NOT execute any tool/i);
    expect(loggerWarn).toHaveBeenCalledWith("completion_guard_rejected", expect.objectContaining({
      requires_environment_tool_result: true,
      has_current_tool_result: false,
    }));
  });

  it.each([
    {
      name: "fake pwd plus Russian output",
      prompt: "Проверь текущую рабочую директорию через pwd",
      output: "pwd\nВывод:\nD:/test CC NODE",
    },
    {
      name: "fake ls -la shell listing",
      prompt: "Покажи реальное содержимое текущей рабочей директории",
      output: "ls -la\ntotal 0\ndrwxr-xr-x 1 user group 0 Aug 20 10:00 .",
    },
    {
      name: "invented cwd attributed to pwd",
      prompt: "Проверь текущую рабочую директорию через pwd",
      output: "Текущая рабочая директория:\nC:\\Users\\Mi\\Desktop\\project\n(Я получил этот путь, выполнив команду pwd.)",
    },
  ])("rejects $name at the DeepSeekClient boundary", async ({ prompt, output }) => {
    const { client, runCompletion } = clientWithOutputs([
      { content: output },
      { content: output },
      { content: output },
    ]);
    await expect(client.complete(request([{
      role: "user",
      parts: [{ type: "text", text: prompt }],
    }]), state())).rejects.toMatchObject({ code: "TOOL_CALL_REQUIRED", status: 502 });
    expect(runCompletion).toHaveBeenCalledTimes(COMPLETION_GUARD_MAX_ATTEMPTS);
  });

  it.each(DIRECTORY_LISTING_POSITIVES)("rejects fabricated plain listing for %s: %s", async (_id, prompt) => {
    const fabricated = "The current directory contains guessed-a.txt and guessed-b.txt.";
    const { client, runCompletion } = clientWithOutputs([
      { content: fabricated },
      { content: fabricated },
      { content: fabricated },
    ]);

    await expect(client.complete(request([{
      role: "user",
      parts: [{ type: "text", text: prompt }],
    }]), state())).rejects.toMatchObject({ code: "TOOL_CALL_REQUIRED", status: 502 });
    expect(runCompletion).toHaveBeenCalledTimes(COMPLETION_GUARD_MAX_ATTEMPTS);
  });

  it.each(DIRECTORY_LISTING_POSITIVES)("accepts a real Bash listing call for %s: %s", async (_id, prompt) => {
    const rawToolCall = '{"tool_call":{"name":"Bash","arguments":{"command":"ls -la"}}}';
    const { client, runCompletion } = clientWithOutputs([{ content: rawToolCall }]);

    const result = await client.complete(request([{
      role: "user",
      parts: [{ type: "text", text: prompt }],
    }]), state());
    expect(result.toolCall).toEqual({ name: "Bash", args: { command: "ls -la" } });
    expect(result.content).toBe("");
    expect(result.content).not.toContain("tool_call");
    expect(runCompletion).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Glob", '{"pattern":"*"}'],
    ["ListDirectory", '{"path":"."}'],
  ] as const)("accepts a real %s call for the exact typo request", async (name, rawArguments) => {
    const { client } = clientWithOutputs([{
      content: `{"tool_call":{"name":"${name}","arguments":${rawArguments}}}`,
    }]);
    const result = await client.complete(request([{
      role: "user",
      parts: [{ type: "text", text: "что находится в данной дериктории?" }],
    }]), state());
    expect(result.toolCall?.name).toBe(name);
    expect(result.content).toBe("");
  });

  it.each(DIRECTORY_LISTING_POSITIVES)("allows final listing after fresh tool_result for %s: %s", async (_id, prompt) => {
    const finalText = "fixture-a.txt\nfixture-b.txt";
    const { client, runCompletion } = clientWithOutputs([{ content: finalText }]);
    const result = await client.complete(request([
      { role: "user", parts: [{ type: "text", text: prompt }] },
      { role: "assistant", parts: [{
        type: "tool_use",
        toolCall: { id: "call_ls", type: "function", name: "Bash", arguments: { command: "ls -la" } },
      }] },
      { role: "user", parts: [{
        type: "tool_result",
        toolResult: { toolUseId: "call_ls", content: finalText },
      }] },
    ]), state());

    expect(result.content).toBe(finalText);
    expect(result.toolCall).toBeUndefined();
    expect(runCompletion).toHaveBeenCalledTimes(1);
  });

  it.each([DIRECTORY_LISTING_POSITIVES[8], DIRECTORY_LISTING_POSITIVES[9]])(
    "does not treat concrete English listing %s as informational or leak raw JSON",
    async (_id, prompt) => {
      const evidence = inspectCurrentToolCycle([{
        role: "user",
        parts: [{ type: "text", text: prompt }],
      }], ["Bash", "Glob"]);
      expect(evidence.isInformationalRequest).toBe(false);

      const rawToolCall = '{"tool_call":{"name":"Glob","arguments":{"pattern":"*"}}}';
      const { client } = clientWithOutputs([{ content: rawToolCall }]);
      const result = await client.complete(request([{
        role: "user",
        parts: [{ type: "text", text: prompt }],
      }]), state());
      expect(result.toolCall).toEqual({ name: "Glob", args: { pattern: "*" } });
      expect(result.content).toBe("");
      expect(result.content).not.toContain(rawToolCall);
    },
  );

  it("does not create an impossible listing requirement without a listing-capable tool", async () => {
    const finalText = "I cannot inspect directories with the available file-only tool.";
    const { client, runCompletion } = clientWithOutputs([{ content: finalText }]);
    const result = await client.complete(request([{
      role: "user",
      parts: [{ type: "text", text: "что находится в данной дериктории?" }],
    }], [readTool]), state());
    expect(result.content).toBe(finalText);
    expect(result.toolCall).toBeUndefined();
    expect(runCompletion).toHaveBeenCalledTimes(1);
  });

  it.each(DIRECTORY_LISTING_NEGATIVES)("allows an informational final without tools: %s", async prompt => {
    const answer = "Informational answer.";
    const { client, runCompletion } = clientWithOutputs([{ content: answer }]);
    const result = await client.complete(request([{
      role: "user",
      parts: [{ type: "text", text: prompt }],
    }]), state());
    expect(result.content).toBe(answer);
    expect(result.toolCall).toBeUndefined();
    expect(runCompletion).toHaveBeenCalledTimes(1);
  });

  it("returns a real Bash tool_call immediately", async () => {
    const { client, runCompletion } = clientWithOutputs([{
      content: '{"tool_call":{"name":"Bash","arguments":{"command":"pwd"}}}',
    }]);
    const result = await client.complete(request([{
      role: "user",
      parts: [{ type: "text", text: "Проверь текущий cwd через pwd" }],
    }]), state());

    expect(result.toolCall).toEqual({ name: "Bash", args: { command: "pwd" } });
    expect(result.content).toBe("");
    expect(runCompletion).toHaveBeenCalledTimes(1);
  });

  it("allows final output after a real tool_result in the latest client turn", async () => {
    const finalText = "pwd\nВывод:\nD:/test CC NODE";
    const { client, runCompletion } = clientWithOutputs([{ content: finalText }]);
    const result = await client.complete(request([
      { role: "user", parts: [{ type: "text", text: "Проверь текущий cwd" }] },
      { role: "assistant", parts: [{
        type: "tool_use",
        toolCall: { id: "call_pwd", type: "function", name: "Bash", arguments: { command: "pwd" } },
      }] },
      { role: "user", parts: [{
        type: "tool_result",
        toolResult: { toolUseId: "call_pwd", content: "D:/test CC NODE" },
      }] },
    ]), state());

    expect(result.content).toBe(finalText);
    expect(result.toolCall).toBeUndefined();
    expect(runCompletion).toHaveBeenCalledTimes(1);
  });

  it("rejects a new environment claim when only a historical tool_result exists", async () => {
    const fake = "pwd\nВывод:\nD:/test CC NODE";
    const { client, runCompletion } = clientWithOutputs([
      { content: fake },
      { content: fake },
      { content: fake },
    ]);
    await expect(client.complete(request([
      { role: "user", parts: [{ type: "text", text: "Старый запрос cwd" }] },
      { role: "assistant", parts: [{
        type: "tool_use",
        toolCall: { id: "call_old", type: "function", name: "Bash", arguments: { command: "pwd" } },
      }] },
      { role: "user", parts: [{
        type: "tool_result",
        toolResult: { toolUseId: "call_old", content: "D:/old" },
      }] },
      { role: "assistant", parts: [{ type: "text", text: "Старый ответ" }] },
      { role: "user", parts: [{ type: "text", text: "Проверь текущую рабочую директорию заново" }] },
    ]), state())).rejects.toMatchObject({ code: "TOOL_CALL_REQUIRED" });
    expect(runCompletion).toHaveBeenCalledTimes(COMPLETION_GUARD_MAX_ATTEMPTS);
  });

  it("does not satisfy the exact typo listing request with a historical tool_result", async () => {
    const fabricated = "The directory contains stale-history.txt.";
    const { client, runCompletion } = clientWithOutputs([
      { content: fabricated },
      { content: fabricated },
      { content: fabricated },
    ]);
    await expect(client.complete(request([
      { role: "user", parts: [{ type: "text", text: "Старый запрос списка файлов" }] },
      { role: "assistant", parts: [{
        type: "tool_use",
        toolCall: { id: "call_old_ls", type: "function", name: "Bash", arguments: { command: "ls -la" } },
      }] },
      { role: "user", parts: [{
        type: "tool_result",
        toolResult: { toolUseId: "call_old_ls", content: "stale-history.txt" },
      }] },
      { role: "assistant", parts: [{ type: "text", text: "Старый список" }] },
      { role: "user", parts: [{ type: "text", text: "что находится в данной дериктории?" }] },
    ]), state())).rejects.toMatchObject({ code: "TOOL_CALL_REQUIRED", status: 502 });
    expect(runCompletion).toHaveBeenCalledTimes(COMPLETION_GUARD_MAX_ATTEMPTS);
  });

  it("allows a normal informational answer about pwd", async () => {
    const answer = "pwd — команда, которая печатает текущую рабочую директорию процесса.";
    const { client, runCompletion } = clientWithOutputs([{ content: answer }]);
    const result = await client.complete(request([{
      role: "user",
      parts: [{ type: "text", text: "Что такое pwd?" }],
    }]), state());

    expect(result.content).toBe(answer);
    expect(result.toolCall).toBeUndefined();
    expect(runCompletion).toHaveBeenCalledTimes(1);
  });

  function failedBashMessages(): CanonicalMessage[] {
    return [
      { role: "user", parts: [{ type: "text", text: "Выполни команду false" }] },
      { role: "assistant", parts: [{
        type: "tool_use",
        toolCall: { id: "call_false", type: "function", name: "Bash", arguments: { command: "false" } },
      }] },
      { role: "user", parts: [{
        type: "tool_result",
        toolResult: { toolUseId: "call_false", content: "exit code 1", isError: true },
      }] },
    ];
  }

  it("bounds identical failed tool retries without returning them to the client", async () => {
    const repeated = '{"tool_call":{"name":"Bash","arguments":{"command":"false"}}}';
    const { client, runCompletion } = clientWithOutputs([
      { content: repeated },
      { content: repeated },
      { content: repeated },
    ]);
    const onToolCall = vi.fn();

    await expect(client.complete(
      request(failedBashMessages()),
      state(),
      { onToolCall },
    )).rejects.toMatchObject({
      code: "TOOL_CALL_REQUIRED",
      status: 502,
      message: expect.stringMatching(/failed action was not executed again/i),
    });
    expect(runCompletion).toHaveBeenCalledTimes(COMPLETION_GUARD_MAX_ATTEMPTS);
    expect(runCompletion.mock.calls[1]?.[0]).toMatch(/Do NOT repeat that call unchanged/i);
    expect(onToolCall).not.toHaveBeenCalled();
  });

  it("allows recovery through a Bash call with changed arguments", async () => {
    const { client, runCompletion } = clientWithOutputs([{
      content: '{"tool_call":{"name":"Bash","arguments":{"command":"printf RECOVERY-OK"}}}',
    }]);
    const result = await client.complete(request(failedBashMessages()), state());

    expect(result.toolCall).toEqual({ name: "Bash", args: { command: "printf RECOVERY-OK" } });
    expect(runCompletion).toHaveBeenCalledTimes(1);
  });

  it("returns a non-empty BridgeError when repeated failure retries end in an empty final", async () => {
    const repeated = '{"tool_call":{"name":"Bash","arguments":{"command":"false"}}}';
    const { client, runCompletion } = clientWithOutputs([
      { content: repeated },
      { content: repeated },
      { content: "" },
    ]);

    let caught: unknown;
    try {
      await client.complete(request(failedBashMessages()), state());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "TOOL_CALL_REQUIRED", status: 502 });
    expect((caught as Error).message.trim().length).toBeGreaterThan(0);
    expect(runCompletion).toHaveBeenCalledTimes(COMPLETION_GUARD_MAX_ATTEMPTS);
  });
});

describe("pseudo-xml tool intent leakage", () => {
  const xmlTools = [
    { name: "Read", description: "Read a file", inputSchema: { type: "object", properties: { file_path: { type: "string" } } } },
    { name: "Write", description: "Write a file", inputSchema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } } } },
    { name: "Bash", description: "Run a command", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
  ];
  const xmlNames = xmlTools.map(tool => tool.name);
  const pseudoXml = '<tool_calls>\n<invoke name="Bash">\n<parameter name="command">pwd</parameter>\n</invoke>\n</tool_calls>';

  function fulfilledMutationEvidence() {
    return inspectCurrentToolCycle([
      { role: "user", parts: [{ type: "text", text: "Создай файл note-927.txt с текстом DONE-927 и проверь его." }] },
      { role: "assistant", parts: [{
        type: "tool_use",
        toolCall: { id: "call_w927", type: "function", name: "Write", arguments: { file_path: "note-927.txt", content: "DONE-927" } },
      }] },
      { role: "user", parts: [{
        type: "tool_result",
        toolResult: { toolUseId: "call_w927", content: "File created successfully", isError: false },
      }] },
    ], xmlNames);
  }

  it("blocks pseudo-xml final after obligations are already fulfilled", () => {
    const evidence = fulfilledMutationEvidence();
    expect(evidence.missingObligations).toHaveLength(0);
    expect(looksLikeMalformedToolIntent(pseudoXml, xmlNames)).toBe(true);
    const malformed = looksLikeMalformedToolIntent(pseudoXml, xmlNames);
    expect(shouldRetry(true, null, pseudoXml, "", xmlNames, evidence, malformed)).toBe(true);
  });

  it("blocks pseudo-xml while an obligation is still pending", () => {
    const evidence = inspectCurrentToolCycle([
      { role: "user", parts: [{ type: "text", text: "Создай файл note-927.txt с текстом DONE-927 и проверь его." }] },
    ], xmlNames);
    expect(looksLikeMalformedToolIntent(pseudoXml, xmlNames)).toBe(true);
    expect(shouldRetry(true, null, pseudoXml, "", xmlNames, evidence, true)).toBe(true);
  });

  it("blocks pseudo-xml after a failed tool_result", () => {
    const evidence = inspectCurrentToolCycle([
      { role: "user", parts: [{ type: "text", text: "Прочитай note-927.txt и проверь его содержимое." }] },
      { role: "assistant", parts: [{
        type: "tool_use",
        toolCall: { id: "call_r927", type: "function", name: "Read", arguments: { file_path: "note-927.txt" } },
      }] },
      { role: "user", parts: [{
        type: "tool_result",
        toolResult: { toolUseId: "call_r927", content: "ENOENT: no such file", isError: true },
      }] },
    ], xmlNames);
    expect(shouldRetry(true, null, pseudoXml, "", xmlNames, evidence, true)).toBe(true);
  });

  it("does not block ordinary XML/HTML or unknown-name invokes", () => {
    const harmless = [
      "<tool_calls>\n</tool_calls>",
      '<invoke name="NotATool"><parameter name="x">1</parameter></invoke>',
      '<tool_calls><invoke name="NotATool"></invoke></tool_calls>',
      '<div class="note">note-927.txt готов</div>',
      "<ul><li>пункт</li></ul>",
      'Пример XML: <invoke name="Bash">',
      'Чтобы вызвать инструмент, напиши <invoke name="Bash"> с параметрами.',
    ];
    for (const snippet of harmless) {
      expect(looksLikeMalformedToolIntent(snippet, xmlNames)).toBe(false);
    }
    const evidence = fulfilledMutationEvidence();
    for (const snippet of harmless) {
      expect(shouldRetry(true, null, snippet, "", xmlNames, evidence)).toBe(false);
    }
  });

  it("blocks executable pseudo-xml shapes without a wrapper", () => {
    const bareInvokeParam = '<invoke name="Bash"><parameter name="command">pwd</parameter></invoke>';
    expect(looksLikeMalformedToolIntent(bareInvokeParam, xmlNames)).toBe(true);
    const multiline = '<invoke name="Write">\n<parameter name="file_path">\nnote-927.txt\n</parameter>\n<parameter name="content">\nDONE-927\n</parameter>\n</invoke>';
    expect(looksLikeMalformedToolIntent(multiline, xmlNames)).toBe(true);
    expect(looksLikeMalformedToolIntent('<invoke name="Bash"></invoke>', xmlNames)).toBe(false);
    expect(looksLikeMalformedToolIntent('<tool_calls><invoke name="Bash"></invoke></tool_calls>', xmlNames)).toBe(false);
  });

  it("keeps canonical tool_call parsing intact", () => {
    const envelope = inspectToolCallFromOutput({ content: '{"tool_call":{"name":"Bash","arguments":{"command":"pwd"}}}', reasoning: "" }, xmlNames);
    expect(envelope.toolCall?.name).toBe("Bash");
    expect(envelope.malformedToolIntent).toBe(false);
    const wrapped = inspectToolCallFromOutput({ content: '<tool_call>{"name":"Write","arguments":{"file_path":"a.txt","content":"b"}}</tool_call>', reasoning: "" }, xmlNames);
    expect(wrapped.toolCall?.name).toBe("Write");
    expect(wrapped.malformedToolIntent).toBe(false);
  });

  it("repairs a malformed marker with final text after all obligations are fulfilled", async () => {
    const client = new DeepSeekClient({
      baseUrl: "https://example.com",
      auth: { token: "test-token", cookie: "test-cookie" },
      sessionManager: {} as never,
      solver: {} as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
      redactor: { addSecret: () => {}, redactText: (text: string) => text } as never,
      timeoutMs: 10_000,
      maxRetries: 0,
    });
    const queue = [pseudoXml, "DONE-927"];
    const runCompletion = vi.fn(async (_prompt: string, _state: UpstreamSessionState, _authGeneration: number) => ({
      content: queue.shift() ?? "",
      reasoning: "",
      parentMessageId: null,
    }));
    Object.defineProperty(client, "runCompletion", { value: runCompletion });

    const result = await client.complete({
      model: "deepseek-v4-flash",
      stream: false,
      system: "cwd: D:/landing-live",
      messages: [
        { role: "user", parts: [{ type: "text", text: "Создай файл note-927.txt с текстом DONE-927 и проверь его." }] },
        { role: "assistant", parts: [{
          type: "tool_use",
          toolCall: { id: "call_w927", type: "function", name: "Write", arguments: { file_path: "note-927.txt", content: "DONE-927" } },
        }] },
        { role: "user", parts: [{
          type: "tool_result",
          toolResult: { toolUseId: "call_w927", content: "File created successfully", isError: false },
        }] },
      ],
      tools: xmlTools,
    }, { chatSessionId: "xml-session", parentMessageId: null, history: [], updatedAt: 0 });

    expect(result.toolCall).toBeUndefined();
    expect(runCompletion).toHaveBeenCalledTimes(2);
    const retryPrompt = runCompletion.mock.calls[1]?.[0] ?? "";
    expect(retryPrompt).toMatch(/malformed tool call/i);
    expect(retryPrompt).toContain("Every current-user requirement already has fresh successful tool evidence.");
    expect(retryPrompt).toContain("Return only the final text answer now.");
    expect(retryPrompt).toContain("Do not repeat already verified steps unless a missing requirement genuinely depends on doing so.");
    expect(retryPrompt).toContain("note-927.txt");
    expect(result.content).toBe("DONE-927");
  });
});

describe("D19 semantic tool admission", () => {
  const toolNames = ["Write", "Edit", "Read", "Bash"];
  const tools = toolNames.map(name => ({
    name,
    description: name,
    inputSchema: { type: "object", additionalProperties: true },
  }));
  const prompt = [
    "Создай файл r3-edit.txt с точным содержимым ALPHA-731.",
    "Затем с помощью Edit замени ALPHA-731 на BETA-731.",
    "После этого прочитай файл.",
    "Только после успешного чтения ответь R3-EDIT-OK.",
  ].join("\n");
  const use = (id: string, name: string, args: Record<string, unknown>): CanonicalMessage => ({
    role: "assistant",
    parts: [{ type: "tool_use", toolCall: { id, type: "function", name, arguments: args } }],
  });
  const result = (id: string, content = "ok"): CanonicalMessage => ({
    role: "user",
    parts: [{ type: "tool_result", toolResult: { toolUseId: id, content, isError: false } }],
  });
  const write = (id = "w1") => use(id, "Write", { file_path: "r3-edit.txt", content: "ALPHA-731" });
  const edit = (id = "e1") => use(id, "Edit", { file_path: "r3-edit.txt", old_string: "ALPHA-731", new_string: "BETA-731" });
  const read = (id = "r1") => use(id, "Read", { file_path: "r3-edit.txt" });
  const cycle = (...messages: CanonicalMessage[]): CanonicalMessage[] => [
    { role: "user", parts: [{ type: "text", text: prompt }] },
    ...messages,
  ];
  const request = (messages: CanonicalMessage[]): CanonicalRequest => ({
    model: "deepseek-v4-flash",
    stream: false,
    system: "",
    messages,
    tools,
  });
  const state = (): UpstreamSessionState => ({
    chatSessionId: "d19-session",
    parentMessageId: null,
    history: [],
    updatedAt: 0,
  });
  const clientWithOutputs = (outputs: string[]) => {
    const client = new DeepSeekClient({
      baseUrl: "https://example.com",
      auth: { token: "test-token", cookie: "test-cookie" },
      sessionManager: {} as never,
      solver: {} as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
      redactor: { addSecret: () => {}, redactText: (text: string) => text } as never,
      timeoutMs: 10_000,
      maxRetries: 0,
    });
    const runCompletion = vi.fn(async (_prompt: string, _state: UpstreamSessionState, _authGeneration: number) => ({
      content: outputs.shift() ?? "",
      reasoning: "",
      candidateMessageId: null,
    }));
    Object.defineProperty(client, "runCompletion", { value: runCompletion });
    return { client, runCompletion };
  };

  it("infers exactly create, Edit, and final Read for the exact R3-C prompt", () => {
    const obligations = inferToolObligations(prompt, toolNames);
    expect(obligations.map(item => item.kind)).toEqual(["file_mutation", "file_mutation", "file_verification"]);
    expect(obligations[1]?.requiredToolName).toBe("Edit");
    expect(obligations.every(item => item.argumentLiterals.includes("r3-edit.txt"))).toBe(true);
  });

  it("does not treat edit inside r3-edit.txt as an action", () => {
    const obligations = inferToolObligations("Создай файл r3-edit.txt с содержимым ALPHA-731.", toolNames);
    expect(obligations.filter(item => item.kind === "file_mutation")).toHaveLength(1);
  });

  it("treats meta wording with Edit as a tool constraint, not another action", () => {
    const obligations = inferToolObligations("Создай r3-edit.txt. Затем с помощью Edit замени ALPHA-731 на BETA-731.", toolNames);
    expect(obligations.filter(item => item.kind === "file_mutation")).toHaveLength(2);
    expect(obligations[1]?.requiredToolName).toBe("Edit");
  });

  it("recognizes Russian replace wording as the intended mutation", () => {
    const obligations = inferToolObligations("Создай r3-edit.txt. Затем замени ALPHA-731 на BETA-731.", toolNames);
    expect(obligations.filter(item => item.kind === "file_mutation")).toHaveLength(2);
  });

  it("lets a bare Read phrase inherit one unambiguous current target", () => {
    const obligations = inferToolObligations("Создай only.txt. После этого прочитай файл.", toolNames);
    expect(obligations.map(item => item.kind)).toEqual(["file_mutation", "file_verification"]);
    expect(obligations[1]?.argumentLiterals).toContain("only.txt");
  });

  it("accepts final text after Write, Edit, and Read without duplicate calls", async () => {
    const { client, runCompletion } = clientWithOutputs(["R3-EDIT-OK"]);
    const response = await client.complete(request(cycle(
      write(), result("w1"), edit(), result("e1"), read(), result("r1", "BETA-731"),
    )), state());
    expect(response.content).toBe("R3-EDIT-OK");
    expect(response.toolCall).toBeUndefined();
    expect(runCompletion).toHaveBeenCalledTimes(1);
  });

  it("rejects a completed Write retry and exposes the missing Edit instead", async () => {
    const { client, runCompletion } = clientWithOutputs([
      '{"tool_call":{"name":"Write","arguments":{"file_path":"r3-edit.txt","content":"ALPHA-731"}}}',
      '{"tool_call":{"name":"Edit","arguments":{"file_path":"r3-edit.txt","old_string":"ALPHA-731","new_string":"BETA-731"}}}',
    ]);
    const response = await client.complete(request(cycle(write(), result("w1"))), state());
    expect(response.toolCall?.name).toBe("Edit");
    expect(runCompletion).toHaveBeenCalledTimes(2);
    expect(runCompletion.mock.calls[1]?.[0]).toContain("does not satisfy a still-unverified current-user requirement");
  });

  it("rejects a completed Edit retry and exposes the missing Read instead", async () => {
    const { client, runCompletion } = clientWithOutputs([
      '{"tool_call":{"name":"Edit","arguments":{"file_path":"r3-edit.txt","old_string":"ALPHA-731","new_string":"BETA-731"}}}',
      '{"tool_call":{"name":"Read","arguments":{"file_path":"r3-edit.txt"}}}',
    ]);
    const response = await client.complete(request(cycle(write(), result("w1"), edit(), result("e1"))), state());
    expect(response.toolCall?.name).toBe("Read");
    expect(runCompletion).toHaveBeenCalledTimes(2);
  });

  it("keeps a completed Read valid when no later mutation occurred", async () => {
    const { client, runCompletion } = clientWithOutputs([
      '{"tool_call":{"name":"Read","arguments":{"file_path":"r3-edit.txt"}}}',
      "R3-EDIT-OK",
    ]);
    const response = await client.complete(request(cycle(
      write(), result("w1"), edit(), result("e1"), read(), result("r1", "BETA-731"),
    )), state());
    expect(response.content).toBe("R3-EDIT-OK");
    expect(response.toolCall).toBeUndefined();
    expect(runCompletion).toHaveBeenCalledTimes(2);
  });

  it("marks Read evidence stale after a later mutation", () => {
    const evidence = inspectCurrentToolCycle(cycle(
      write(), result("w1"), edit(), result("e1"), read(), result("r1", "BETA-731"),
      use("e2", "Edit", { file_path: "r3-edit.txt", old_string: "BETA-731", new_string: "GAMMA-731" }), result("e2"),
    ), toolNames);
    expect(evidence.staleObligations.map(item => item.kind)).toContain("file_verification");
  });

  it("permits a fresh Read when verification became stale", () => {
    const evidence = inspectCurrentToolCycle(cycle(
      write(), result("w1"), edit(), result("e1"), read(), result("r1", "BETA-731"),
      use("e2", "Edit", { file_path: "r3-edit.txt", old_string: "BETA-731", new_string: "GAMMA-731" }), result("e2"),
    ), toolNames);
    expect(shouldRetry(true, { id: "r2", type: "function", name: "Read", arguments: { file_path: "r3-edit.txt" } }, "", "", toolNames, evidence)).toBe(false);
  });

  it("does not permit Write or Edit replay to satisfy stale verification", () => {
    const evidence = inspectCurrentToolCycle(cycle(
      write(), result("w1"), edit(), result("e1"), read(), result("r1", "BETA-731"),
      use("e2", "Edit", { file_path: "r3-edit.txt", old_string: "BETA-731", new_string: "GAMMA-731" }), result("e2"),
    ), toolNames);
    expect(shouldRetry(true, { id: "w2", type: "function", name: "Write", arguments: { file_path: "r3-edit.txt", content: "ALPHA-731" } }, "", "", toolNames, evidence)).toBe(true);
    expect(shouldRetry(true, { id: "e3", type: "function", name: "Edit", arguments: { file_path: "r3-edit.txt", old_string: "GAMMA-731", new_string: "DELTA-731" } }, "", "", toolNames, evidence)).toBe(true);
  });

  it("blocks a final after a later mutation without a fresh Read", () => {
    const evidence = inspectCurrentToolCycle(cycle(
      write(), result("w1"), edit(), result("e1"), read(), result("r1", "BETA-731"),
      use("e2", "Edit", { file_path: "r3-edit.txt", old_string: "BETA-731", new_string: "GAMMA-731" }), result("e2"),
    ), toolNames);
    expect(shouldRetry(true, null, "R3-EDIT-OK", "", toolNames, evidence)).toBe(true);
  });

  it("allows the final after the stale Read is refreshed", () => {
    const evidence = inspectCurrentToolCycle(cycle(
      write(), result("w1"), edit(), result("e1"), read(), result("r1", "BETA-731"),
      use("e2", "Edit", { file_path: "r3-edit.txt", old_string: "BETA-731", new_string: "GAMMA-731" }), result("e2"),
      read("r2"), result("r2", "GAMMA-731"),
    ), toolNames);
    expect(shouldRetry(true, null, "R3-EDIT-OK", "", toolNames, evidence)).toBe(false);
  });

  it("keeps two explicitly requested Edit actions distinct", () => {
    const obligations = inferToolObligations("Edit report.txt twice.", toolNames);
    expect(obligations.filter(item => item.kind === "file_mutation")).toHaveLength(2);
  });

  it("keeps two explicitly requested Read actions distinct", () => {
    const obligations = inferToolObligations("Read report.txt twice.", toolNames);
    expect(obligations.filter(item => item.kind === "file_verification")).toHaveLength(2);
  });

  it("admits each genuinely missing R3-C action once", () => {
    const initial = inspectCurrentToolCycle(cycle(), toolNames);
    const afterWrite = inspectCurrentToolCycle(cycle(write(), result("w1")), toolNames);
    const afterEdit = inspectCurrentToolCycle(cycle(write(), result("w1"), edit(), result("e1")), toolNames);
    expect(shouldRetry(true, { id: "w1", type: "function", name: "Write", arguments: { file_path: "r3-edit.txt", content: "ALPHA-731" } }, "", "", toolNames, initial)).toBe(false);
    expect(shouldRetry(true, { id: "e1", type: "function", name: "Edit", arguments: { file_path: "r3-edit.txt", old_string: "ALPHA-731", new_string: "BETA-731" } }, "", "", toolNames, afterWrite)).toBe(false);
    expect(shouldRetry(true, { id: "r1", type: "function", name: "Read", arguments: { file_path: "r3-edit.txt" } }, "", "", toolNames, afterEdit)).toBe(false);
    expect(shouldRetry(true, { id: "w2", type: "function", name: "Write", arguments: { file_path: "r3-edit.txt", content: "ALPHA-731" } }, "", "", toolNames, afterWrite)).toBe(true);
  });
});

describe("multiple obligation instances per kind", () => {
  function ob(id: string, kind: ToolObligation["kind"], argumentLiterals: string[], resultLiterals: string[] = []): ToolObligation {
    return { id, kind, description: id, argumentLiterals, resultLiterals };
  }
  function ev(sequence: number, name: string, args: Record<string, unknown>, content = "ok") {
    return {
      toolCall: { id: `c${sequence}`, type: "function" as const, name, arguments: args },
      resultContent: content,
      sequence,
    };
  }
  const mutation = (sequence: number, path: string) => ev(sequence, "Write", { file_path: path });

  it("binds one evidence to a single same-kind instance only", () => {
    const obligations = [ob("file_mutation#1", "file_mutation", ["a.txt"]), ob("file_mutation#2", "file_mutation", ["b.txt"])];
    const matches = matchObligationsToEvidence(obligations, [mutation(1, "a.txt")]);
    expect(matches.size).toBe(1);
    expect(matches.has(0)).toBe(true);
    expect(matches.has(1)).toBe(false);
  });

  it("binds sequential evidence to distinct same-kind instances in order", () => {
    const obligations = [ob("file_mutation#1", "file_mutation", ["a.txt"]), ob("file_mutation#2", "file_mutation", ["b.txt"])];
    const matches = matchObligationsToEvidence(obligations, [mutation(1, "a.txt"), mutation(2, "b.txt")]);
    expect(matches.size).toBe(2);
    expect(matches.get(0)?.sequence).toBe(1);
    expect(matches.get(1)?.sequence).toBe(2);
  });

  it("does not bind the second step when its literals are missing", () => {
    const obligations = [ob("file_mutation#1", "file_mutation", ["a.txt"]), ob("file_mutation#2", "file_mutation", ["b.txt"])];
    const matches = matchObligationsToEvidence(obligations, [mutation(1, "a.txt"), mutation(2, "a-copy.txt")]);
    expect(matches.size).toBe(1);
    expect(matches.has(0)).toBe(true);
  });

  it("still lets one evidence satisfy obligations of different kinds", () => {
    const obligations = [
      ob("file_mutation#1", "file_mutation", ["a.txt"]),
      ob("command_execution#1", "command_execution", []),
    ];
    const bashAppend = {
      toolCall: { id: "c1", type: "function" as const, name: "Bash", arguments: { command: 'echo hi >> a.txt' } },
      resultContent: "ok",
      sequence: 1,
    };
    const matches = matchObligationsToEvidence(obligations, [bashAppend]);
    expect(matches.size).toBe(2);
    expect(matches.get(0)?.toolCall.id).toBe("c1");
    expect(matches.get(1)?.toolCall.id).toBe("c1");
  });

  it("reassigns earlier bindings so both instances stay served", () => {
    const wide = ob("wide", "file_mutation", ["tok-a"]);
    const unique = ob("unique", "file_mutation", ["tok-q"]);
    const evidence = [ev(1, "Write", { content: "tok-a tok-q" }), ev(2, "Write", { content: "tok-a" })];
    const matches = matchObligationsToEvidence([wide, unique], evidence);
    expect(matches.size).toBe(2);
    expect(matches.get(0)?.sequence).toBe(2);
    expect(matches.get(1)?.sequence).toBe(1);
  });

  it("ignores structured-error results and empty inputs", () => {
    const obligations = [ob("file_mutation#1", "file_mutation", ["a.txt"])];
    const failed = { ...mutation(1, "a.txt"), resultContent: '{"error":"ENOENT"}' };
    expect(matchObligationsToEvidence(obligations, [failed]).size).toBe(0);
    expect(matchObligationsToEvidence([], []).size).toBe(0);
    expect(matchObligationsToEvidence(obligations, []).size).toBe(0);
  });
});

describe("distinct file mutation obligations", () => {
  const multiTools = [
    { name: "Read", description: "Read a file", inputSchema: { type: "object", properties: { file_path: { type: "string" } } } },
    { name: "Write", description: "Write a file", inputSchema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } } } },
    { name: "Edit", description: "Edit a file", inputSchema: {} },
    { name: "Bash", description: "Run a command", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
  ];
  const multiNames = multiTools.map(tool => tool.name);

  function msg(role: "user" | "assistant", parts: unknown[]): CanonicalMessage {
    return { role, parts } as unknown as CanonicalMessage;
  }
  const tu = (id: string, name: string, args: Record<string, unknown>): CanonicalMessage =>
    msg("assistant", [{ type: "tool_use", toolCall: { id, type: "function", name, arguments: args } }]);
  const tr = (id: string, content: string): CanonicalMessage =>
    msg("user", [{ type: "tool_result", toolResult: { toolUseId: id, content, isError: false } }]);
  const cycle = (prompt: string, calls: CanonicalMessage[]) =>
    inspectCurrentToolCycle([msg("user", [{ type: "text", text: prompt }]), ...calls], multiNames);

  it("infers two file_mutation obligations for two distinct paths", () => {
    const obligations = inferToolObligations('Создай файл a.txt со строкой "XA". Создай файл b.txt со строкой "XB".', multiNames);
    const mutationIds = obligations.filter(o => o.kind === "file_mutation").map(o => o.id);
    expect(mutationIds).toEqual(["file_mutation#1", "file_mutation#2"]);
    expect(obligations.find(o => o.id === "file_mutation#1")?.argumentLiterals).toEqual(["a.txt"]);
    expect(obligations.find(o => o.id === "file_mutation#2")?.argumentLiterals).toEqual(["b.txt"]);
  });

  it("keeps the second obligation missing after only the first write", () => {
    const evidence = cycle('Создай файл a.txt со строкой "XA". Создай файл b.txt со строкой "XB".', [
      tu("c1", "Write", { file_path: "a.txt", content: "XA" }),
      tr("c1", "File created successfully"),
    ]);
    expect(evidence.fulfilledObligationIds).toContain("file_mutation#1");
    expect(evidence.missingObligations.map(o => o.id)).toContain("file_mutation#2");
    expect(evidence.requiresActionToolResult).toBe(true);
  });

  it("fulfills both after both files are written once", () => {
    const evidence = cycle('Создай файл a.txt со строкой "XA". Создай файл b.txt со строкой "XB".', [
      tu("c1", "Write", { file_path: "a.txt", content: "XA" }),
      tr("c1", "ok"),
      tu("c2", "Write", { file_path: "b.txt", content: "XB" }),
      tr("c2", "ok"),
    ]);
    expect(evidence.fulfilledObligationIds).toEqual(expect.arrayContaining(["file_mutation#1", "file_mutation#2"]));
    expect(evidence.missingObligations).toHaveLength(0);
    expect(evidence.requiresActionToolResult).toBe(false);
  });

  it("keeps b.txt missing when an unrelated c.txt is written instead", () => {
    const evidence = cycle('Создай файл a.txt со строкой "XA". Создай файл b.txt со строкой "XB".', [
      tu("c1", "Write", { file_path: "a.txt", content: "XA" }),
      tr("c1", "ok"),
      tu("c2", "Write", { file_path: "c.txt", content: "XC" }),
      tr("c2", "ok"),
    ]);
    expect(evidence.missingObligations.map(o => o.id)).toContain("file_mutation#2");
    expect(evidence.requiresActionToolResult).toBe(true);
  });

  it("keeps the historical single obligation for one path", () => {
    const obligations = inferToolObligations('Создай файл report.txt со строкой "XR" и проверь его.', multiNames);
    expect(obligations.filter(o => o.kind === "file_mutation").map(o => o.id)).toEqual(["file_mutation"]);
  });

  it("does not split when the same path is mentioned twice", () => {
    const obligations = inferToolObligations('Создай файл a.txt со строкой "XA". Затем обнови a.txt ещё раз.', multiNames);
    expect(obligations.filter(o => o.kind === "file_mutation").map(o => o.id)).toEqual(["file_mutation"]);
  });

  it("splits three distinct paths instead of falling back to one generic obligation", () => {
    const obligations = inferToolObligations("Создай a.txt, b.txt и c.txt.", multiNames);
    expect(obligations.filter(o => o.kind === "file_mutation").map(o => o.id))
      .toEqual(["file_mutation#1", "file_mutation#2", "file_mutation#3"]);
  });

  it("falls back when an isolated third path has unknown context", () => {
    const filler = "перед этим обязательно внимательно изучи структуру проекта и контекст, ";
    const obligations = inferToolObligations(`Создай a.txt и запиши b.txt. ${filler}${filler}Сформируй c.txt.`, multiNames);
    expect(obligations.filter(o => o.kind === "file_mutation").map(o => o.id)).toEqual(["file_mutation"]);
    expect(obligations.find(o => o.id === "file_mutation")?.argumentLiterals)
      .toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  it("keeps the split when the third path is a verification target", () => {
    const obligations = inferToolObligations("Создай a.txt и b.txt, затем прочитай c.txt.", multiNames);
    expect(obligations.filter(o => o.kind === "file_mutation").map(o => o.id))
      .toEqual(["file_mutation#1", "file_mutation#2"]);
  });

  it("one tool result cannot close both same-kind instances", () => {
    const evidence = cycle('Создай файл a.txt со строкой "XA". Создай файл b.txt со строкой "XB".', [
      tu("c1", "Write", { file_path: "a.txt", content: "XA b.txt" }),
      tr("c1", "ok"),
    ]);
    expect(evidence.fulfilledObligationIds).not.toContain("file_mutation#2");
    expect(evidence.missingObligations.map(o => o.id)).toContain("file_mutation#2");
  });
});

describe("D13 multi-target obligation fidelity", () => {
  const tools = ["Read", "Write", "Edit", "Bash", "Glob"];

  function msg(role: "user" | "assistant", parts: unknown[]): CanonicalMessage {
    return { role, parts } as unknown as CanonicalMessage;
  }
  const tu = (id: string, name: string, args: Record<string, unknown>): CanonicalMessage =>
    msg("assistant", [{ type: "tool_use", toolCall: { id, type: "function", name, arguments: args } }]);
  const tr = (id: string, content = "ok", isError = false): CanonicalMessage =>
    msg("user", [{ type: "tool_result", toolResult: { toolUseId: id, content, isError } }]);
  const cycle = (prompt: string, calls: CanonicalMessage[]) =>
    inspectCurrentToolCycle([msg("user", [{ type: "text", text: prompt }]), ...calls], tools);
  const kind = (prompt: string, obligationKind: "file_mutation" | "file_verification") =>
    inferToolObligations(prompt, tools).filter(obligation => obligation.kind === obligationKind);
  const clauses = (verb: string, count: number) =>
    Array.from({ length: count }, (_, index) => `${verb} f${index + 1}.txt.`).join(" ");
  const success = (name: "Write" | "Edit" | "Read", count: number): CanonicalMessage[] =>
    Array.from({ length: count }, (_, index) => {
      const id = `c${index + 1}`;
      const args = name === "Edit"
        ? { file_path: `f${index + 1}.txt`, old_string: "old", new_string: "new" }
        : { file_path: `f${index + 1}.txt`, ...(name === "Write" ? { content: `value-${index + 1}` } : {}) };
      return [tu(id, name, args), tr(id)];
    }).flat();

  it.each([1, 2, 3, 4, 5])("keeps %i independent create target(s)", count => {
    const obligations = kind(clauses("Create", count), "file_mutation");
    expect(obligations).toHaveLength(count);
    expect(obligations.map(obligation => obligation.argumentLiterals))
      .toEqual(Array.from({ length: count }, (_, index) => [`f${index + 1}.txt`]));
  });

  it.each([1, 2, 3, 4, 5])("keeps %i independent edit target(s)", count => {
    const obligations = kind(clauses("Edit", count), "file_mutation");
    expect(obligations).toHaveLength(count);
    expect(obligations.map(obligation => obligation.argumentLiterals))
      .toEqual(Array.from({ length: count }, (_, index) => [`f${index + 1}.txt`]));
  });

  it.each([2, 3, 4, 5])("keeps and independently fulfills %i read target(s)", count => {
    const prompt = clauses("Read", count);
    const obligations = kind(prompt, "file_verification");
    expect(obligations).toHaveLength(count);
    const evidence = cycle(prompt, success("Read", count));
    expect(evidence.missingObligations).toHaveLength(0);
    expect(evidence.fulfilledObligationIds).toHaveLength(count);
  });

  it("keeps B and C missing when only A succeeds", () => {
    const prompt = clauses("Create", 3);
    const evidence = cycle(prompt, success("Write", 1));
    expect(evidence.fulfilledObligationIds).toEqual(["file_mutation#1"]);
    expect(evidence.missingObligations.map(obligation => obligation.id))
      .toEqual(["file_mutation#2", "file_mutation#3"]);
  });

  it("keeps only C missing when A and B succeed", () => {
    const prompt = clauses("Create", 3);
    const evidence = cycle(prompt, success("Write", 2));
    expect(evidence.fulfilledObligationIds).toEqual(["file_mutation#1", "file_mutation#2"]);
    expect(evidence.missingObligations.map(obligation => obligation.id)).toEqual(["file_mutation#3"]);
  });

  it("allows final completion only after all three targets succeed", () => {
    const evidence = cycle(clauses("Create", 3), success("Write", 3));
    expect(evidence.requiresActionToolResult).toBe(false);
    expect(evidence.missingObligations).toHaveLength(0);
  });

  it("keeps a failed middle mutation missing", () => {
    const prompt = clauses("Create", 3);
    const calls = success("Write", 3);
    calls[3] = tr("c2", "permission denied", true);
    const evidence = cycle(prompt, calls);
    expect(evidence.missingObligations.map(obligation => obligation.id)).toEqual(["file_mutation#2"]);
  });

  it("retry requirements omit an already fulfilled target", () => {
    const prompt = clauses("Create", 3);
    const evidence = cycle(prompt, success("Write", 1));
    const retry = createToolRetryPrompt(tools, {
      missingObligations: evidence.missingObligations.map(obligation => obligation.description),
      fulfilledObligations: evidence.obligations
        .filter(obligation => evidence.fulfilledObligationIds.includes(obligation.id))
        .map(obligation => obligation.description),
    });
    const missingLine = retry.split("\n").find(line => line.startsWith("Still-unverified current-user requirements:"));
    expect(missingLine).not.toContain("f1.txt");
    expect(missingLine).toContain("f2.txt");
    expect(missingLine).toContain("f3.txt");
  });

  it("keeps mixed read, edit, and create targets independent", () => {
    const prompt = "Read a.txt. Edit b.txt. Create c.txt.";
    const obligations = inferToolObligations(prompt, tools).filter(obligation =>
      obligation.kind === "file_mutation" || obligation.kind === "file_verification");
    expect(obligations.map(obligation => [obligation.id, obligation.argumentLiterals])).toEqual([
      ["file_mutation#1", ["b.txt"]],
      ["file_mutation#2", ["c.txt"]],
      ["file_verification", ["a.txt"]],
    ]);
  });

  it("keeps three distinguishable same-file additive steps", () => {
    const prompt = 'Create report.txt with content: "ALPHA". Then append content: "BETA" to the same file. Then append content: "GAMMA" to the same file.';
    const obligations = kind(prompt, "file_mutation");
    expect(obligations.map(obligation => obligation.id))
      .toEqual(["file_mutation#1", "file_mutation#2", "file_mutation#3"]);
    expect(obligations.map(obligation => obligation.argumentLiterals)).toEqual([
      ["ALPHA", "report.txt"],
      ["BETA", "report.txt"],
      ["GAMMA", "report.txt"],
    ]);
    const oneStep = cycle(prompt, [
      tu("s1", "Write", { file_path: "report.txt", content: "ALPHA" }), tr("s1"),
    ]);
    expect(oneStep.fulfilledObligationIds).toEqual(["file_mutation#1"]);
    expect(oneStep.missingObligations.map(obligation => obligation.id))
      .toEqual(["file_mutation#2", "file_mutation#3"]);
  });

  it("keeps create, edit, and delete on the same target distinct", () => {
    const obligations = kind(
      "Create report.txt. Then edit the same file. Then delete the same file.",
      "file_mutation",
    );
    expect(obligations.map(obligation => obligation.id))
      .toEqual(["file_mutation#1", "file_mutation#2", "file_mutation#3"]);
    expect(obligations.every(obligation => obligation.argumentLiterals.includes("report.txt"))).toBe(true);
  });

  it("does not collapse an explicit twice request on the same target", () => {
    const obligations = kind("Edit report.txt twice.", "file_mutation");
    expect(obligations.map(obligation => obligation.id))
      .toEqual(["file_mutation#1", "file_mutation#2"]);
    expect(obligations.map(obligation => obligation.argumentLiterals))
      .toEqual([["report.txt"], ["report.txt"]]);
  });

  it("keeps an explicit one-command multi-file operation grouped", () => {
    const prompt = "Using one command create a.txt, b.txt and c.txt.";
    const obligations = kind(prompt, "file_mutation");
    expect(obligations).toHaveLength(1);
    expect(obligations[0]?.argumentLiterals).toEqual(["a.txt", "b.txt", "c.txt"]);
    const evidence = cycle(prompt, [
      tu("g1", "Bash", { command: "touch a.txt b.txt c.txt" }),
      tr("g1"),
    ]);
    expect(evidence.missingObligations).toHaveLength(0);
  });

  it("does not let partial evidence fulfill a grouped operation", () => {
    const prompt = "Using one command create a.txt, b.txt and c.txt.";
    const evidence = cycle(prompt, [tu("g1", "Write", { file_path: "a.txt", content: "a" }), tr("g1")]);
    expect(evidence.missingObligations.map(obligation => obligation.id)).toEqual(["file_mutation"]);
  });

  it("distinguishes identical basenames in different directories", () => {
    const obligations = kind("Create one/a.txt. Create two/a.txt. Create three/a.txt.", "file_mutation");
    expect(obligations.map(obligation => obligation.argumentLiterals))
      .toEqual([["one/a.txt"], ["two/a.txt"], ["three/a.txt"]]);
  });

  it("preserves Unicode and space-containing Windows paths", () => {
    const prompt = 'Create path: "D:\\Проекты\\Папка ёжик\\a one.txt". Create path: "D:\\Проекты\\Папка ёжик\\b two.txt".';
    const obligations = kind(prompt, "file_mutation");
    expect(obligations.map(obligation => obligation.argumentLiterals)).toEqual([
      ["D:\\Проекты\\Папка ёжик\\a one.txt"],
      ["D:\\Проекты\\Папка ёжик\\b two.txt"],
    ]);
  });

  it("deduplicates NFC-equivalent path literals without changing separator or case semantics", () => {
    const decomposed = "cafe\u0301.txt";
    const composed = "café.txt";
    const obligations = kind(`Create file path: "${decomposed}". Create file path: "${composed}".`, "file_mutation");
    expect(obligations).toHaveLength(1);
    expect(obligations[0]?.argumentLiterals).toEqual([composed]);
  });

  it("ignores historical successful evidence before the current instruction", () => {
    const messages = [
      msg("user", [{ type: "text", text: "Create a.txt." }]),
      tu("old", "Write", { file_path: "a.txt", content: "old" }),
      tr("old"),
      msg("user", [{ type: "text", text: "Create a.txt. Create b.txt. Create c.txt." }]),
    ];
    const evidence = inspectCurrentToolCycle(messages, tools);
    expect(evidence.fulfilledObligationIds).toHaveLength(0);
    expect(evidence.missingObligations).toHaveLength(3);
  });

  it("keeps a successful read stale after a later mutation of that target", () => {
    const prompt = "Edit a.txt. Then read a.txt.";
    const evidence = cycle(prompt, [
      tu("r1", "Read", { file_path: "a.txt" }), tr("r1", "old"),
      tu("e1", "Edit", { file_path: "a.txt", old_string: "old", new_string: "new" }), tr("e1"),
    ]);
    expect(evidence.staleObligations.map(obligation => obligation.id)).toContain("file_verification");
    expect(evidence.missingObligations.map(obligation => obligation.id)).toContain("file_verification");
  });

  it("does not infer actions from informational filename mentions", () => {
    expect(inferToolObligations("Explain how a.txt, b.txt, and c.txt are normally organized.", tools)).toEqual([]);
  });
});

describe("pronominal file verification completion guard", () => {
  const tools = ["Bash", "Read", "Write"];
  const canonicalTools = [
    { name: "Bash", description: "Run a command", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
    { name: "Read", description: "Read a file", inputSchema: { type: "object", properties: { file_path: { type: "string" } } } },
    { name: "Write", description: "Write a file", inputSchema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } } } },
  ];
  const ruPrompt = [
    "Создай файл premerge-a.txt с точным содержимым:",
    "PREMERGE-A-731",
    "После создания обязательно прочитай этот файл.",
    "Только после успешного чтения напиши:",
    "PREMERGE-WRITE-READ-OK",
  ].join("\n\n");
  const enPrompt = [
    "Create premerge-a.txt with exact content:",
    "PREMERGE-A-731",
    "After creating it, read that file.",
    "Only after reading it reply:",
    "PREMERGE-WRITE-READ-OK",
  ].join("\n\n");

  function msg(role: "user" | "assistant", parts: unknown[]): CanonicalMessage {
    return { role, parts } as unknown as CanonicalMessage;
  }
  const tu = (id: string, name: string, args: Record<string, unknown>): CanonicalMessage =>
    msg("assistant", [{ type: "tool_use", toolCall: { id, type: "function", name, arguments: args } }]);
  const tr = (id: string, content = "ok", isError = false): CanonicalMessage =>
    msg("user", [{ type: "tool_result", toolResult: { toolUseId: id, content, isError } }]);
  const write = (): CanonicalMessage => tu("write", "Write", { file_path: "premerge-a.txt", content: "PREMERGE-A-731" });
  const read = (): CanonicalMessage => tu("read", "Read", { file_path: "premerge-a.txt" });
  const cycle = (prompt: string, calls: CanonicalMessage[] = []) =>
    inspectCurrentToolCycle([msg("user", [{ type: "text", text: prompt }]), ...calls], tools);
  const request = (messages: CanonicalMessage[]): CanonicalRequest => ({
    model: "deepseek-v4-flash",
    stream: true,
    system: "",
    messages,
    tools: canonicalTools,
  });
  const state = (): UpstreamSessionState => ({
    chatSessionId: "pronominal-session",
    parentMessageId: null,
    history: [],
    updatedAt: 0,
  });

  function clientWithOutputs(outputs: string[]) {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    };
    logger.child.mockReturnValue(logger);
    const client = new DeepSeekClient({
      baseUrl: "https://example.invalid",
      auth: { token: "test-token", cookie: "test-cookie" },
      sessionManager: {} as never,
      solver: {} as never,
      logger: logger as never,
      redactor: { addSecret: () => {}, redactText: (text: string) => text } as never,
      timeoutMs: 1_000,
      maxRetries: 0,
    });
    const queue = [...outputs];
    const runCompletion = vi.fn(async () => ({
      content: queue.shift() ?? "",
      reasoning: "",
      candidateMessageId: null,
    }));
    Object.defineProperty(client, "runCompletion", { value: runCompletion });
    return { client, runCompletion, logger };
  }

  function handlerFor(client: DeepSeekClient) {
    Object.defineProperty(client, "ensureSession", {
      value: vi.fn(async (session: UpstreamSessionState) => {
        session.chatSessionId = "pronominal-handler-session";
      }),
    });
    const lineage = {
      getUpstreamKey: vi.fn(),
      record: vi.fn(async () => {}),
      removeByUpstreamKey: vi.fn(async () => {}),
    };
    const stream = {
      start: vi.fn(),
      push: vi.fn(),
      finish: vi.fn(),
      fail: vi.fn(),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    };
    logger.child.mockReturnValue(logger);
    const handler = new CompletionHandler({
      deepseek: client,
      sessionStore: new SessionStore(),
      lineage: lineage as never,
      logger: logger as never,
    });
    return { handler, stream };
  }

  it.each([
    ["RU", ruPrompt],
    ["EN", enPrompt],
  ])("keeps mutation and pronominal verification obligations for %s", (_name, prompt) => {
    expect(inferToolObligations(prompt, tools).map(obligation => [
      obligation.id,
      obligation.argumentLiterals,
    ])).toEqual([
      ["file_mutation", ["premerge-a.txt"]],
      ["file_verification", ["premerge-a.txt"]],
    ]);
  });

  it.each([
    "Создай файл premerge-a.txt. Затем прочитай этот же файл.",
    "Create premerge-a.txt. Then read the same file.",
    "Create premerge-a.txt. Then read it.",
  ])("supports an unambiguous same-file anaphora: %s", prompt => {
    expect(inferToolObligations(prompt, tools).map(obligation => [obligation.id, obligation.argumentLiterals])).toEqual([
      ["file_mutation", ["premerge-a.txt"]],
      ["file_verification", ["premerge-a.txt"]],
    ]);
  });

  const nonExecutablePronominalVerificationCases = [
    ["EN negation", "Create a.txt. Do not read it."],
    ["EN no-need negation", "Create a.txt. You do not need to read it."],
    ["RU no-need negation", "Создай a.txt. Не нужно прочитать этот файл."],
    ["RU no-need aspect", "Создай a.txt. Не надо прочитывать этот файл."],
    ["EN explain", "Create a.txt. Explain how to read it."],
    ["RU explain", "Создай a.txt. Объясни, как прочитать этот файл."],
    ["EN tell how", "Create a.txt. Tell me how to read it."],
    ["EN describe how", "Create a.txt. Describe how to read it."],
    ["EN conditional", "Create a.txt. If necessary, read it."],
    ["RU conditional", "Создай a.txt. Если потребуется, прочитай этот файл."],
    ["EN can later", "Create a.txt. You can read it later."],
    ["EN may if wanted", "Create a.txt. You may read it if you want."],
    ["EN optional gerund", "Create a.txt. Reading it is optional."],
    ["RU optional", "Создай a.txt. Можешь прочитать этот файл позже."],
    ["RU optional preference", "Создай a.txt. При желании можешь прочитать этот файл."],
    ["EN before-reading meta", "Create a.txt. Before reading it, explain the format."],
    ["RU before-reading meta", "Создай a.txt. Перед тем как прочитать этот файл, объясни формат."],
  ] as const;

  it.each(nonExecutablePronominalVerificationCases)(
    "does not synthesize cross-context verification for %s",
    (_name, prompt) => {
      const obligations = inferToolObligations(prompt, tools);
      expect(obligations.map(obligation => obligation.kind)).toContain("file_mutation");
      expect(obligations.map(obligation => obligation.kind)).not.toContain("file_verification");
    },
  );

  const nonExecutablePronominalSuffixCases = [
    ["EN only-if necessary", "Create a.txt. Read it only if necessary."],
    ["EN if needed", "Create a.txt. Read it if needed."],
    ["EN only-if need", "Create a.txt. Read it only if you need to."],
    ["EN if wanted", "Create a.txt. Read it if you want."],
    ["EN but-only-if", "Create a.txt. Read it, but only if necessary."],
    ["EN alternative", "Create a.txt. Read it or just explain how to read it."],
    ["RU only-if", "Создай a.txt. Прочитай этот файл, только если понадобится."],
    ["RU if required", "Создай a.txt. Прочитай этот файл, если потребуется."],
    ["RU if necessary", "Создай a.txt. Прочитай этот файл только при необходимости."],
    ["RU alternative", "Создай a.txt. Прочитай этот файл или просто объясни, как это сделать."],
    ["EN unless", "Create a.txt. Read it unless that is unnecessary."],
    ["EN optional", "Create a.txt. Read it optional."],
    ["EN optionally", "Create a.txt. Read it optionally."],
    ["EN modal suffix", "Create a.txt. You should read it only if needed."],
    ["RU if desired", "Создай a.txt. Прочитай этот файл при желании."],
    ["RU if it becomes needed", "Создай a.txt. Прочитай этот файл, если будет нужно."],
  ] as const;

  const thirdReviewConditionalSuffixCases = [
    ["EN when necessary", "Create a.txt. Read it when necessary."],
    ["EN when needed", "Create a.txt. Read it when needed."],
    ["EN only when", "Create a.txt. Read it only when needed."],
    ["EN whenever", "Create a.txt. Read it whenever necessary."],
    ["EN in case", "Create a.txt. Read it in case you need it."],
    ["EN if possible", "Create a.txt. Read it if possible."],
    ["EN if appropriate", "Create a.txt. Read it if appropriate."],
    ["EN unless", "Create a.txt. Read it unless you decide not to."],
    ["EN or alternative", "Create a.txt. Read it or leave it alone."],
    ["EN either-or", "Create a.txt. Either read it or explain the format."],
    ["RU when", "Создай a.txt. Прочитай этот файл когда понадобится."],
    ["RU only when", "Создай a.txt. Прочитай этот файл только когда потребуется."],
    ["RU extended if", "Создай a.txt. Прочитай этот файл если это будет необходимо."],
    ["RU if possible", "Создай a.txt. Прочитай этот файл если возможно."],
    ["RU when necessary", "Создай a.txt. Прочитай этот файл при необходимости."],
    ["RU either alternative", "Создай a.txt. Прочитай этот файл либо оставь как есть."],
    ["RU or alternative", "Создай a.txt. Прочитай этот файл или оставь как есть."],
  ] as const;

  it.each(nonExecutablePronominalSuffixCases)(
    "does not synthesize unconditional verification for %s",
    (_name, prompt) => {
      const obligations = inferToolObligations(prompt, tools);
      expect(obligations.map(obligation => obligation.kind)).toContain("file_mutation");
      expect(obligations.map(obligation => obligation.kind)).not.toContain("file_verification");
    },
  );

  it.each(thirdReviewConditionalSuffixCases)(
    "does not make the third-review conditional suffix mandatory for %s",
    (_name, prompt) => {
      const obligations = inferToolObligations(prompt, tools);
      expect(obligations.map(obligation => obligation.kind)).toContain("file_mutation");
      expect(obligations.map(obligation => obligation.kind)).not.toContain("file_verification");
    },
  );

  it.each([
    "Create a.txt. Read it.",
    "Create a.txt. Then read it.",
    "Create a.txt. Read it now.",
    "Create a.txt. Read it carefully.",
    "Create a.txt. Read it and report the contents.",
    "Create a.txt. Read it to verify the marker.",
    "Create a.txt. Read it, then tell me what it contains.",
    "If the build succeeds, create a.txt. Then read it.",
    "Создай a.txt. Прочитай этот файл.",
    "Создай a.txt. Затем прочитай этот файл.",
    "Создай a.txt. Прочитай этот файл внимательно.",
    "Создай a.txt. Прочитай этот файл и сообщи содержимое.",
    "Создай a.txt. Прочитай этот файл, чтобы проверить маркер.",
  ])("keeps affirmative post-verbal verification for %s", prompt => {
    const verification = inferToolObligations(prompt, tools)
      .find(obligation => obligation.kind === "file_verification");
    expect(verification?.argumentLiterals).toEqual(["a.txt"]);
  });

  it.each([
    "Create a.txt. Read it.",
    "Create a.txt. Then read it.",
    "Create a.txt. Read it now.",
    "Create a.txt. Read it carefully.",
    "Create a.txt. Read it completely.",
    "Create a.txt. Read it and report its contents.",
    "Create a.txt. Read it to verify the marker.",
    "Create a.txt. Read it before replying.",
    "Create a.txt. Read it before giving the final answer.",
    "Create a.txt. Read it after writing it.",
    "Создай a.txt. Прочитай этот файл.",
    "Создай a.txt. Затем прочитай этот файл.",
    "Создай a.txt. Прочитай этот файл внимательно.",
    "Создай a.txt. Прочитай этот файл и сообщи содержимое.",
    "Создай a.txt. Прочитай этот файл, чтобы проверить маркер.",
    "Создай a.txt. Прочитай этот файл перед финальным ответом.",
  ])("keeps the fourth-followup mandatory recall control: %s", prompt => {
    const verification = inferToolObligations(prompt, tools)
      .find(obligation => obligation.kind === "file_verification");
    expect(verification?.argumentLiterals).toEqual(["a.txt"]);
  });

  it.each([
    "If needed, do nothing else. Create a.txt. Then read it.",
    "Create a.txt. If b.txt exists, leave it alone. Then read it.",
    "Create a.txt. If b.txt exists, leave it alone. Then read a.txt.",
  ])("keeps local verification despite an unrelated conditional clause: %s", prompt => {
    const verification = inferToolObligations(prompt, tools)
      .find(obligation => obligation.kind === "file_verification");
    expect(verification?.argumentLiterals).toEqual(["a.txt"]);
  });

  it.each([
    "If needed, do nothing else. Create a.txt. Then read it.",
    "Create a.txt. If b.txt exists, ignore b.txt. Then read it.",
    "You may ignore b.txt. Create a.txt. Then read it.",
  ])("isolates the local Read from another clause marker: %s", prompt => {
    const verification = inferToolObligations(prompt, tools)
      .find(obligation => obligation.kind === "file_verification");
    expect(verification?.argumentLiterals).toEqual(["a.txt"]);
  });

  it.each([
    ["conditional target before mandatory target", "If needed, create b.txt. Create a.txt. Then read it.", ["a.txt"]],
    ["conditional suffix before mandatory target", "Create b.txt only if needed. Create a.txt. Then read it.", ["a.txt"]],
    ["conditional edit after mandatory target", "Create a.txt. If needed edit b.txt. Then read it.", ["a.txt"]],
    ["two mandatory targets", "Create a.txt. Create b.txt. Then read it.", []],
    ["grouped mandatory targets", "Create a.txt and b.txt. Then read it.", []],
    ["two mandatory actions on one target", "Create a.txt. Edit a.txt. Then read it.", ["a.txt"]],
    ["possible new target ambiguity barrier", "Create a.txt. Create b.txt only if needed. Then read it.", []],
  ])("applies D18 mutation candidate semantics for %s", (_name, prompt, expectedPaths) => {
    const verifications = inferToolObligations(prompt, tools)
      .filter(obligation => obligation.kind === "file_verification");
    expect(verifications.flatMap(obligation => obligation.argumentLiterals)).toEqual(expectedPaths);
  });

  it("accepts a normal final after Write when suffix semantics made Read conditional", () => {
    for (const [, prompt] of nonExecutablePronominalSuffixCases) {
      const evidence = inspectCurrentToolCycle([
        msg("user", [{ type: "text", text: prompt }]),
        tu("write-a", "Write", { file_path: "a.txt", content: "A" }),
        tr("write-a", "File written"),
      ], tools);
      expect(evidence.missingActionKinds, prompt).not.toContain("file_verification");
      expect(shouldRetry(true, null, "done", "", tools, evidence), prompt).toBe(false);
    }
  });

  it("accepts a normal final after Write for every third-review conditional suffix", () => {
    for (const [, prompt] of thirdReviewConditionalSuffixCases) {
      const evidence = inspectCurrentToolCycle([
        msg("user", [{ type: "text", text: prompt }]),
        tu("write-a", "Write", { file_path: "a.txt", content: "A" }),
        tr("write-a", "File written"),
      ], tools);
      expect(evidence.missingActionKinds, prompt).not.toContain("file_verification");
      expect(shouldRetry(true, null, "done", "", tools, evidence), prompt).toBe(false);
    }
  });

  it("keeps verification for the mandatory target after a conditional mutation candidate", () => {
    const prompt = "If needed, create b.txt. Create a.txt. Then read it.";
    const evidence = inspectCurrentToolCycle([
      msg("user", [{ type: "text", text: prompt }]),
      tu("write-a", "Write", { file_path: "a.txt", content: "A" }),
      tr("write-a", "File written"),
    ], tools);
    expect(evidence.missingObligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "file_verification", argumentLiterals: ["a.txt"] }),
    ]));
    expect(evidence.requiresActionToolResult).toBe(true);
  });

  it.each([
    ["unrelated negation", "Do not modify b.txt. Create a.txt. Then read it."],
    ["unrelated explanation", "Explain nothing else. Create a.txt, then read it."],
  ])("keeps an affirmative local verification despite %s", (_name, prompt) => {
    const verification = inferToolObligations(prompt, tools)
      .find(obligation => obligation.kind === "file_verification");
    expect(verification?.argumentLiterals).toEqual(["a.txt"]);
  });

  it.each([
    "Explain how to create a.txt and then read it.",
    "Explain this example: Create a.txt. Then read it.",
  ])("keeps a wholly informational action example tool-free: %s", prompt => {
    expect(inferToolObligations(prompt, tools)).toEqual([]);
  });

  it("does not leave artificial verification missing after Write for non-executable mentions", () => {
    for (const [, prompt] of nonExecutablePronominalVerificationCases) {
      const evidence = inspectCurrentToolCycle([
        msg("user", [{ type: "text", text: prompt }]),
        tu("write-a", "Write", { file_path: "a.txt", content: "A" }),
        tr("write-a", "File written"),
      ], tools);
      expect(evidence.missingActionKinds, prompt).not.toContain("file_verification");
      expect(shouldRetry(true, null, "done", "", tools, evidence), prompt).toBe(false);
    }
  });

  it("keeps verification missing after the successful Write result", () => {
    const evidence = cycle(ruPrompt, [write(), tr("write", "File written")]);

    expect(evidence.hasCurrentToolResult).toBe(true);
    expect(evidence.hasSuccessfulCurrentToolResult).toBe(true);
    expect(evidence.fulfilledObligationIds).toEqual(["file_mutation"]);
    expect(evidence.missingObligations.map(obligation => obligation.id)).toEqual(["file_verification"]);
    expect(evidence.missingActionKinds).toEqual(["file_verification"]);
    expect(evidence.requiresActionToolResult).toBe(true);
  });

  it("fulfills verification only after a fresh successful Read result", () => {
    const afterWrite = cycle(ruPrompt, [write(), tr("write", "File written")]);
    const afterRead = cycle(ruPrompt, [
      write(), tr("write", "File written"), read(), tr("read", "PREMERGE-A-731"),
    ]);

    expect(afterWrite.fulfilledObligationIds).not.toContain("file_verification");
    expect(afterRead.fulfilledObligationIds).toEqual(["file_mutation", "file_verification"]);
    expect(afterRead.missingObligations).toEqual([]);
    expect(shouldRetry(true, null, "PREMERGE-WRITE-READ-OK", "", tools, afterRead)).toBe(false);
  });

  it("allows a canonical Read call while verification is pending", () => {
    const evidence = cycle(ruPrompt, [write(), tr("write", "File written")]);
    const inspection = inspectToolCallFromOutput({
      content: '{"tool_call":{"name":"Read","arguments":{"file_path":"premerge-a.txt"}}}',
      reasoning: "",
    }, tools);

    expect(inspection.toolCall).toMatchObject({ name: "Read", arguments: { file_path: "premerge-a.txt" } });
    expect(shouldRetry(true, inspection.toolCall, "", "", tools, evidence, inspection.malformedToolIntent)).toBe(false);
  });

  it.each([
    String.raw`[调用 Read] {"file_path":"D:\\x\\a.txt"}`,
    String.raw`[调用Read] {"file_path":"D:\\x\\a.txt"}`,
    String.raw`[调用 Write] {"file_path":"D:\\x\\a.txt","content":"x"}`,
    String.raw`[调用 Bash] {"command":"pwd"}`,
    String.raw`[调用 Read] {"file_path":"D:\DeepSeek-Bridge-Premerge-Live\premerge-a.txt"}`,
  ])("classifies a bracketed allowed-tool invocation as malformed without executing it: %s", raw => {
    const inspection = inspectToolCallFromOutput({ content: raw, reasoning: "" }, tools);

    expect(inspection.toolCall).toBeNull();
    expect(inspection.malformedToolIntent).toBe(true);
    expect(looksLikeMalformedToolIntent(raw, tools)).toBe(true);
  });

  it("retries a bracketed marker even when the existing successful result fulfilled every obligation", () => {
    const writeOnly = "Создай файл premerge-a.txt.";
    const evidence = cycle(writeOnly, [write(), tr("write", "File written")]);
    const marker = String.raw`[调用 Read] {"file_path":"D:\\x\\a.txt"}`;
    const inspection = inspectToolCallFromOutput({ content: marker, reasoning: "" }, tools);

    expect(evidence.hasSuccessfulCurrentToolResult).toBe(true);
    expect(evidence.missingObligations).toEqual([]);
    expect(shouldRetry(
      true,
      inspection.toolCall,
      marker,
      "",
      tools,
      evidence,
      inspection.malformedToolIntent,
    )).toBe(true);
  });

  it.each([
    String.raw`[调用 Unknown] {"file_path":"a.txt"}`,
    String.raw`Example: [调用 Read] {"file_path":"a.txt"}`,
    String.raw`The documentation says "[调用 Read] {\"file_path\":\"a.txt\"}".`,
  ])("does not classify unknown or explanatory marker text as executable intent: %s", text => {
    expect(looksLikeMalformedToolIntent(text, tools)).toBe(false);
    expect(inspectToolCallFromOutput({ content: text, reasoning: "" }, tools).malformedToolIntent).toBe(false);
  });

  it.each([
    "Create a.txt and b.txt. Then read it.",
    "Create a.txt. Create b.txt. Then read that file.",
  ])("does not guess a verification referent among multiple targets: %s", prompt => {
    const verifications = inferToolObligations(prompt, tools)
      .filter(obligation => obligation.kind === "file_verification");
    expect(verifications).toEqual([]);
  });

  it("keeps an explicit different verification target", () => {
    const obligations = inferToolObligations("Create a.txt. Then read b.txt.", tools);
    expect(obligations.map(obligation => [obligation.id, obligation.argumentLiterals])).toEqual([
      ["file_mutation", ["a.txt"]],
      ["file_verification", ["b.txt"]],
    ]);
  });

  it("preserves existing explicit-path Write to Read behavior", () => {
    const prompt = "Создай файл premerge-a.txt. Затем прочитай файл premerge-a.txt.";
    expect(inferToolObligations(prompt, tools).map(obligation => [obligation.id, obligation.argumentLiterals])).toEqual([
      ["file_mutation", ["premerge-a.txt"]],
      ["file_verification", ["premerge-a.txt"]],
    ]);
  });

  it("does not synthesize verification without a Read-like tool", () => {
    expect(inferToolObligations(ruPrompt, ["Write", "Bash"]).map(obligation => obligation.kind))
      .toEqual(["file_mutation"]);
  });

  it("ignores historical and failed Read results but accepts a fresh success", () => {
    const historical = inspectCurrentToolCycle([
      msg("user", [{ type: "text", text: "Read premerge-a.txt." }]),
      read(), tr("read", "PREMERGE-A-731"),
      msg("assistant", [{ type: "text", text: "Old result" }]),
      msg("user", [{ type: "text", text: ruPrompt }]),
    ], tools);
    const failed = cycle(ruPrompt, [
      write(), tr("write", "File written"), read(), tr("read", "permission denied", true),
    ]);
    const fresh = cycle(ruPrompt, [
      write(), tr("write", "File written"), read(), tr("read", "PREMERGE-A-731"),
    ]);
    const stale = cycle(ruPrompt, [
      read(), tr("read", "PREMERGE-A-731"), write(), tr("write", "File written"),
    ]);

    expect(historical.fulfilledObligationIds).toEqual([]);
    expect(historical.missingObligations.map(obligation => obligation.id))
      .toEqual(["file_mutation", "file_verification"]);
    expect(failed.fulfilledObligationIds).toEqual(["file_mutation"]);
    expect(failed.missingObligations.map(obligation => obligation.id)).toEqual(["file_verification"]);
    expect(fresh.fulfilledObligationIds).toEqual(["file_mutation", "file_verification"]);
    expect(stale.fulfilledObligationIds).toEqual(["file_mutation"]);
    expect(stale.staleObligations.map(obligation => obligation.id)).toEqual(["file_verification"]);
  });

  it("boundedly rejects repeated raw markers instead of accepting them as final", async () => {
    const marker = String.raw`[调用 Read] {"file_path":"D:\DeepSeek-Bridge-Premerge-Live\premerge-a.txt"}`;
    const { client, runCompletion } = clientWithOutputs([marker, marker, marker]);

    await expect(client.complete(request([
      msg("user", [{ type: "text", text: ruPrompt }]), write(), tr("write", "File written"),
    ]), state())).rejects.toMatchObject({ code: "TOOL_CALL_REQUIRED", status: 502 });
    expect(runCompletion).toHaveBeenCalledTimes(COMPLETION_GUARD_MAX_ATTEMPTS);
  });

  it("does not expose a raw marker through CompletionHandler", async () => {
    const marker = String.raw`[调用 Read] {"file_path":"D:\DeepSeek-Bridge-Premerge-Live\premerge-a.txt"}`;
    const { client } = clientWithOutputs([marker, marker, marker]);
    const { handler, stream } = handlerFor(client);

    await expect(handler.run({
      protocol: "anthropic",
      request: request([msg("user", [{ type: "text", text: ruPrompt }]), write(), tr("write", "File written")]),
      headers: {},
      body: {},
      stream: stream as never,
    })).rejects.toMatchObject({ code: "TOOL_CALL_REQUIRED", status: 502 });
    expect(stream.push).not.toHaveBeenCalled();
    expect(stream.finish).not.toHaveBeenCalled();
  });

  it("exposes a repaired canonical Read call through CompletionHandler", async () => {
    const marker = String.raw`[调用 Read] {"file_path":"D:\DeepSeek-Bridge-Premerge-Live\premerge-a.txt"}`;
    const canonical = '{"tool_call":{"name":"Read","arguments":{"file_path":"premerge-a.txt"}}}';
    const { client, runCompletion } = clientWithOutputs([marker, canonical]);
    const { handler, stream } = handlerFor(client);

    const result = await handler.run({
      protocol: "anthropic",
      request: request([msg("user", [{ type: "text", text: ruPrompt }]), write(), tr("write", "File written")]),
      headers: {},
      body: {},
      stream: stream as never,
    });

    expect(runCompletion).toHaveBeenCalledTimes(2);
    expect(result.result.toolCalls[0]).toMatchObject({ name: "Read", arguments: { file_path: "premerge-a.txt" } });
    expect(stream.push).toHaveBeenCalledWith(expect.objectContaining({
      type: "tool_use",
      toolCall: expect.objectContaining({ name: "Read", arguments: { file_path: "premerge-a.txt" } }),
    }));
    expect(stream.push).not.toHaveBeenCalledWith(expect.objectContaining({ type: "content", text: marker }));
  });
});

describe("same-file additive final-state verification", () => {
  const tools = ["Bash", "Read", "Write", "Edit"];
  const basePrompt = 'Создай report.txt с содержимым "STEP-1". Затем добавь строку "STEP-2".';

  function msg(role: "user" | "assistant", parts: unknown[]): CanonicalMessage {
    return { role, parts } as unknown as CanonicalMessage;
  }
  const tu = (id: string, name: string, args: Record<string, unknown>): CanonicalMessage =>
    msg("assistant", [{ type: "tool_use", toolCall: { id, type: "function", name, arguments: args } }]);
  const tr = (id: string, content: string): CanonicalMessage =>
    msg("user", [{ type: "tool_result", toolResult: { toolUseId: id, content, isError: false } }]);
  const cycle = (prompt: string, calls: CanonicalMessage[]) =>
    inspectCurrentToolCycle([msg("user", [{ type: "text", text: prompt }]), ...calls], tools);

  const fvOf = (obligations: ToolObligation[]) => obligations.find(o => o.kind === "file_verification");
  const w = (content: string) => tu("w", "Write", { file_path: "report.txt", content });
  const editStep = () => tu("e", "Edit", { file_path: "report.txt", old_string: "STEP-1", new_string: "STEP-2" });
  const append = () => tu("a", "Bash", { command: 'echo "STEP-2" >> report.txt' });
  const read = (result: string): CanonicalMessage[] => [tu("r", "Read", { file_path: "report.txt" }), tr("r", result)];
  const destructiveWrite = () => tu("d", "Write", { file_path: "report.txt", content: "STEP-2" });

  it("synthesizes a final-state verification for two sequential clauses", () => {
    const obligations = inferToolObligations(basePrompt, tools);
    expect(obligations.filter(o => o.kind === "file_verification")).toHaveLength(1);
    const fv = fvOf(obligations);
    expect(fv?.argumentLiterals).toEqual(["report.txt"]);
    expect(fv?.resultLiterals).toEqual(["STEP-1", "STEP-2"]);
    expect(obligations.find(o => o.kind === "file_mutation")?.argumentLiterals).toEqual(["STEP-1", "report.txt"]);
  });

  it("rejects a destructive rewrite that drops the first value (fresh read shows only STEP-2)", () => {
    const evidence = cycle(basePrompt, [w("STEP-1"), tr("w", "ok"), destructiveWrite(), tr("d", "ok"), ...read("STEP-2")]);
    expect(evidence.missingObligations.map(o => o.id)).toContain("file_verification");
    expect(evidence.requiresActionToolResult).toBe(true);
  });

  it("rejects an Edit replacement whose fresh read shows only STEP-2", () => {
    const evidence = cycle(basePrompt, [w("STEP-1"), tr("w", "ok"), editStep(), tr("e", "ok"), ...read("STEP-2")]);
    expect(evidence.missingObligations.map(o => o.id)).toContain("file_verification");
  });

  it("fulfills after a one-shot write plus fresh read of both values", () => {
    const evidence = cycle(basePrompt, [
      w("STEP-1\nSTEP-2"), tr("w", "ok"), ...read("STEP-1\nSTEP-2"),
    ]);
    expect(evidence.fulfilledObligationIds).toContain("file_verification");
    expect(evidence.missingObligations).toHaveLength(0);
    expect(evidence.requiresActionToolResult).toBe(false);
  });

  it("fulfills after write + append + fresh read of both values", () => {
    const evidence = cycle(basePrompt, [
      w("STEP-1"), tr("w", "ok"), append(), tr("a", "done"), ...read("STEP-1\nSTEP-2"),
    ]);
    expect(evidence.fulfilledObligationIds).toContain("file_verification");
    expect(evidence.missingObligations).toHaveLength(0);
  });

  it("keeps verification missing after append followed by a destructive rewrite", () => {
    const evidence = cycle(basePrompt, [
      w("STEP-1"), tr("w", "ok"), append(), tr("a", "done"),
      destructiveWrite(), tr("d", "ok"), ...read("STEP-2"),
    ]);
    expect(evidence.missingObligations.map(o => o.id)).toContain("file_verification");
  });

  it("treats an early full read as stale once a later mutation invalidates it", () => {
    const evidence = cycle(basePrompt, [
      w("x"), tr("w", "ok"), ...read("STEP-1\nSTEP-2"), editStep(), tr("e", "ok"),
    ]);
    expect(evidence.staleObligations.map(o => o.id)).toContain("file_verification");
    expect(evidence.missingObligations.map(o => o.id)).toContain("file_verification");
  });

  it("merges into an existing user-requested verification instead of duplicating", () => {
    const prompt = `${basePrompt} После этого проверь файл report.txt.`;
    const obligations = inferToolObligations(prompt, tools);
    const verifications = obligations.filter(o => o.kind === "file_verification");
    expect(verifications).toHaveLength(1);
    expect(verifications[0]!.resultLiterals).toEqual(["STEP-1", "STEP-2"]);
  });

  it("does not synthesize without a sequence marker", () => {
    const obligations = inferToolObligations('Создай report.txt с содержимым "STEP-1". Добавь строку "STEP-2".', tools);
    expect(fvOf(obligations)).toBeUndefined();
  });

  it("does not synthesize for conditional/or phrasing", () => {
    const orPrompt = 'Создай или измени report.txt со строкой "X". Затем добавь строку "Y".';
    expect(fvOf(inferToolObligations(orPrompt, tools))).toBeUndefined();
    const condPrompt = 'Если report.txt существует, измени его. Иначе создай его со строкой "X". Затем добавь строку "Y".';
    expect(fvOf(inferToolObligations(condPrompt, tools))).toBeUndefined();
  });

  it("does not synthesize for replace chains", () => {
    const arrow = 'Измени report.txt: "OLD"→"MID". Затем измени "MID"→"FINAL".';
    expect(fvOf(inferToolObligations(arrow, tools))).toBeUndefined();
    const verbal = 'Замени в report.txt "OLD" на "MID". Затем замени "MID" на "FINAL".';
    expect(fvOf(inferToolObligations(verbal, tools))).toBeUndefined();
  });

  it("does not synthesize when no Read-like tool is available", () => {
    const obligations = inferToolObligations(basePrompt, ["Bash", "Write", "Edit"]);
    expect(fvOf(obligations)).toBeUndefined();
  });

  it("does not synthesize for three sequential mutation clauses", () => {
    const prompt = 'Создай report.txt с содержимым "S1". Затем добавь строку "S2". Затем добавь строку "S3".';
    expect(fvOf(inferToolObligations(prompt, tools))).toBeUndefined();
  });

  it("accepts pronominal same-file continuation in the second clause", () => {
    const prompt = 'Создай report.txt с содержимым "STEP-1". Затем добавь в этот же файл строку "STEP-2".';
    const fv = fvOf(inferToolObligations(prompt, tools));
    expect(fv?.resultLiterals).toEqual(["STEP-1", "STEP-2"]);
  });

  it("does not synthesize for destructive RU edit clause", () => {
    const prompt = 'Создай report.txt с содержимым "STEP-1". Затем измени report.txt так, чтобы содержимое стало "STEP-2".';
    expect(fvOf(inferToolObligations(prompt, tools))).toBeUndefined();
  });

  it("does not synthesize for destructive EN edit clause", () => {
    const prompt = 'Create report.txt with "STEP-1". Then edit it so the final content is "STEP-2".';
    expect(fvOf(inferToolObligations(prompt, tools))).toBeUndefined();
  });

  it("does not synthesize for a removal clause", () => {
    const prompt = 'Создай report.txt с содержимым "STEP-1". Затем удали из него строку "TMP-X".';
    expect(fvOf(inferToolObligations(prompt, tools))).toBeUndefined();
  });

  it("does not synthesize for an overwrite clause", () => {
    const prompt = 'Создай log.txt со строкой "S1". Затем перезапиши его содержимым "S2".';
    expect(fvOf(inferToolObligations(prompt, tools))).toBeUndefined();
  });

  it("still synthesizes for RU additive second clause", () => {
    const fv = fvOf(inferToolObligations(basePrompt, tools));
    expect(fv?.resultLiterals).toEqual(["STEP-1", "STEP-2"]);
  });

  it("still synthesizes for EN add and append second clauses", () => {
    const add = 'Create report.txt with "STEP-1". Then add "STEP-2".';
    expect(fvOf(inferToolObligations(add, tools))?.resultLiterals).toEqual(["STEP-1", "STEP-2"]);
    const append = 'Create report.txt with "STEP-1". Then append "STEP-2" to the file.';
    expect(fvOf(inferToolObligations(append, tools))?.resultLiterals).toEqual(["STEP-1", "STEP-2"]);
  });

  it("does not synthesize when a pronominal clause also names a foreign path (RU)", () => {
    const prompt = 'Создай a.txt с содержимым "A". Затем в этот же файл добавь "B" и сохрани результат в b.txt.';
    expect(fvOf(inferToolObligations(prompt, tools))).toBeUndefined();
  });

  it("does not synthesize when a same-file clause also names another path (EN)", () => {
    const prompt = 'Create a.txt with "A". Then append "B" to the same file and save the result to another.txt.';
    expect(fvOf(inferToolObligations(prompt, tools))).toBeUndefined();
  });
});

describe("DeepSeekClient action completion guard", () => {
  const actionTools = [
    { name: "Artifact", description: "Create an artifact", inputSchema: {} },
    { name: "Skill", description: "Load a skill", inputSchema: {} },
    { name: "Write", description: "Write a file", inputSchema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } } } },
    { name: "Edit", description: "Edit a file", inputSchema: {} },
    { name: "Bash", description: "Run a command", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
  ];

  function actionRequest(messages: CanonicalMessage[]): CanonicalRequest {
    return {
      model: "deepseek-v4-flash",
      stream: false,
      system: "cwd: D:/landing-live",
      messages,
      tools: actionTools,
    };
  }

  function actionClient(outputs: string[]) {
    const client = new DeepSeekClient({
      baseUrl: "https://example.com",
      auth: { token: "test-token", cookie: "test-cookie" },
      sessionManager: {} as never,
      solver: {} as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
      redactor: { addSecret: () => {}, redactText: (text: string) => text } as never,
      timeoutMs: 10_000,
      maxRetries: 0,
    });
    const queue = [...outputs];
    const runCompletion = vi.fn(async (_prompt: string, _state: UpstreamSessionState, _authGeneration: number) => ({
      content: queue.shift() ?? "",
      reasoning: "",
      parentMessageId: null,
    }));
    Object.defineProperty(client, "runCompletion", { value: runCompletion });
    return { client, runCompletion };
  }

  function actionState(): UpstreamSessionState {
    return { chatSessionId: "action-session", parentMessageId: null, history: [], updatedAt: 0 };
  }

  function d13Messages(completed: number): CanonicalMessage[] {
    const messages: CanonicalMessage[] = [{
      role: "user",
      parts: [{ type: "text", text: "Create a.txt. Create b.txt. Create c.txt." }],
    }];
    for (let index = 0; index < completed; index++) {
      const id = `d13-${index + 1}`;
      const path = `${String.fromCharCode(97 + index)}.txt`;
      messages.push({
        role: "assistant",
        parts: [{ type: "tool_use", toolCall: { id, type: "function", name: "Write", arguments: { file_path: path, content: path } } }],
      });
      messages.push({
        role: "user",
        parts: [{ type: "tool_result", toolResult: { toolUseId: id, content: "ok", isError: false } }],
      });
    }
    return messages;
  }

  it("D13 root guard rejects plain final after only A and does not request A again", async () => {
    const { client, runCompletion } = actionClient(["All done.", "All done.", "All done."]);
    await expect(client.complete(actionRequest(d13Messages(1)), actionState()))
      .rejects.toMatchObject({ code: "TOOL_CALL_REQUIRED", status: 502 });
    expect(runCompletion).toHaveBeenCalledTimes(COMPLETION_GUARD_MAX_ATTEMPTS);
    const retry = runCompletion.mock.calls[1]?.[0] ?? "";
    const missingLine = retry.split("\n").find(line => line.startsWith("Still-unverified current-user requirements:"));
    expect(missingLine).not.toContain("a.txt");
    expect(missingLine).toContain("b.txt");
    expect(missingLine).toContain("c.txt");
  });

  it("D13 root guard rejects plain final after A and B", async () => {
    const { client, runCompletion } = actionClient(["All done.", "All done.", "All done."]);
    await expect(client.complete(actionRequest(d13Messages(2)), actionState()))
      .rejects.toMatchObject({ code: "TOOL_CALL_REQUIRED", status: 502 });
    expect(runCompletion).toHaveBeenCalledTimes(COMPLETION_GUARD_MAX_ATTEMPTS);
    const retry = runCompletion.mock.calls[1]?.[0] ?? "";
    const missingLine = retry.split("\n").find(line => line.startsWith("Still-unverified current-user requirements:"));
    expect(missingLine).not.toContain("a.txt");
    expect(missingLine).not.toContain("b.txt");
    expect(missingLine).toContain("c.txt");
  });

  it("D13 root guard accepts final only after A, B, and C", async () => {
    const { client, runCompletion } = actionClient(["All three files are ready."]);
    const result = await client.complete(actionRequest(d13Messages(3)), actionState());
    expect(result.content).toBe("All three files are ready.");
    expect(runCompletion).toHaveBeenCalledTimes(1);
  });

  it("D17 root guard accepts the completed three-Write three-Read cycle without retry or Bash", async () => {
    const { client, runCompletion } = actionClient(["Все три файла созданы и проверены."]);
    const request = actionRequest(d17FileCycleMessages());
    request.tools = [
      ...actionTools,
      { name: "Read", description: "Read a file", inputSchema: { type: "object", properties: { file_path: { type: "string" } } } },
    ];

    const result = await client.complete(request, actionState());

    expect(result.content).toBe("Все три файла созданы и проверены.");
    expect(result.toolCall).toBeUndefined();
    expect(runCompletion).toHaveBeenCalledTimes(1);
  });

  it("filters Artifact at the root and retries with a supported tool", async () => {
    const { client, runCompletion } = actionClient([
      '{"tool_call":{"name":"Artifact","arguments":{"type":"html"}}}',
      '{"tool_call":{"name":"Write","arguments":{"file_path":"index.html","content":"<html></html>"}}}',
    ]);
    const result = await client.complete(actionRequest([{
      role: "user",
      parts: [{ type: "text", text: "создай index.html" }],
    }]), actionState());

    expect(result.toolCall?.name).toBe("Write");
    expect(runCompletion).toHaveBeenCalledTimes(2);
    expect(runCompletion.mock.calls[0]?.[0]).not.toContain("- Artifact");
    expect(runCompletion.mock.calls[0]?.[0]).toContain("- Skill");
    expect(runCompletion.mock.calls[0]?.[0]).toContain("- Write");
    expect(runCompletion.mock.calls[1]?.[0]).toMatch(/Artifact is unavailable through this Bridge session/i);
  });

  it("rejects repeated text-only success for a requested action", async () => {
    const falseSuccess = "Готово, index.html создан.";
    const { client, runCompletion } = actionClient([falseSuccess, falseSuccess, falseSuccess]);
    await expect(client.complete(actionRequest([{
      role: "user",
      parts: [{ type: "text", text: "создай index.html" }],
    }]), actionState())).rejects.toMatchObject({ code: "TOOL_CALL_REQUIRED", status: 502 });
    expect(runCompletion).toHaveBeenCalledTimes(COMPLETION_GUARD_MAX_ATTEMPTS);
  });

  it("returns non-empty TOOL_CALL_REQUIRED after multi-step obligation exhaustion", async () => {
    const falseSuccess = "Готово: задача создана, API и storage проверены, тесты прошли, сервер работает.";
    const { client, runCompletion } = actionClient([falseSuccess, falseSuccess, falseSuccess]);
    const prompt = 'создай задачу с названием "Проверка UTF-8 — ёжик №482" и описанием "Съешь ещё этих мягких французских булок"; проверь через API; проверь файл хранения data/tasks.json; запусти тесты; оставь приложение работающим';

    let caught: unknown;
    try {
      await client.complete(actionRequest([{
        role: "user",
        parts: [{ type: "text", text: prompt }],
      }]), actionState());
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "TOOL_CALL_REQUIRED", status: 502 });
    expect((caught as Error).message).toMatch(/every current-user obligation/i);
    expect((caught as Error).message.trim().length).toBeGreaterThan(0);
    expect(runCompletion).toHaveBeenCalledTimes(COMPLETION_GUARD_MAX_ATTEMPTS);
    expect(runCompletion.mock.calls[1]?.[0]).toContain("Still-unverified current-user requirements");
    expect(runCompletion.mock.calls[1]?.[0]).toContain("Проверка UTF-8 — ёжик №482");
  });

  it("retries stale final-state evidence with a fresh GET instead of accepting final text", async () => {
    const title = "FINAL-CHECK — ёжик №731";
    const description = "Проверка единственного создания и полного цикла UTF-8";
    const prompt = `Создай ровно одну новую задачу:\ntitle:\n${title}\ndescription:\n${description}\nЗатем проверь итог через API, проверь storage-файл data/tasks.json и запусти все тесты.`;
    const post = `node -e "fetch('http://127.0.0.1:3000/api/tasks', {method:'POST', body: JSON.stringify({title:'${title}', description:'${description}'})})"`;
    const messages: CanonicalMessage[] = [
      { role: "user", parts: [{ type: "text", text: prompt }] },
      { role: "assistant", parts: [{ type: "tool_use", toolCall: { id: "post", type: "function", name: "Bash", arguments: { command: post } } }] },
      { role: "user", parts: [{ type: "tool_result", toolResult: { toolUseId: "post", content: "created" } }] },
      { role: "assistant", parts: [{ type: "tool_use", toolCall: { id: "api", type: "function", name: "Bash", arguments: { command: "curl http://127.0.0.1:3000/api/tasks" } } }] },
      { role: "user", parts: [{ type: "tool_result", toolResult: { toolUseId: "api", content: JSON.stringify([{ title, description }]) } }] },
      { role: "assistant", parts: [{ type: "tool_use", toolCall: { id: "tests", type: "function", name: "Bash", arguments: { command: "npm test" } } }] },
      { role: "user", parts: [{ type: "tool_result", toolResult: { toolUseId: "tests", content: "29 tests passed" } }] },
    ];
    const { client, runCompletion } = actionClient([
      "Готово: финальное состояние проверено.",
      '{"tool_call":{"name":"Bash","arguments":{"command":"curl http://127.0.0.1:3000/api/tasks"}}}',
    ]);

    const result = await client.complete(actionRequest(messages), actionState());

    expect(result.toolCall).toEqual({
      name: "Bash",
      args: { command: "curl http://127.0.0.1:3000/api/tasks" },
    });
    expect(runCompletion).toHaveBeenCalledTimes(2);
    expect(runCompletion.mock.calls[1]?.[0]).toContain("Stale final-state verifications");
    expect(runCompletion.mock.calls[1]?.[0]).toContain("Do NOT repeat an already successful mutation or POST");
  });

  it("retries fabricated success after an Artifact error", async () => {
    const { client, runCompletion } = actionClient([
      "Создал лендинг, index.html сохранён и открыт в браузере.",
      '{"tool_call":{"name":"Write","arguments":{"file_path":"index.html","content":"<html></html>"}}}',
    ]);
    const result = await client.complete(actionRequest([
      { role: "user", parts: [{ type: "text", text: "создай лендинг и запусти его" }] },
      { role: "assistant", parts: [{
        type: "tool_use",
        toolCall: { id: "call_artifact", type: "function", name: "Artifact", arguments: { type: "html" } },
      }] },
      { role: "user", parts: [{
        type: "tool_result",
        toolResult: { toolUseId: "call_artifact", content: "Artifacts need a claude.ai login", isError: true },
      }] },
    ]), actionState());

    expect(result.toolCall?.name).toBe("Write");
    expect(runCompletion).toHaveBeenCalledTimes(2);
    expect(runCompletion.mock.calls[0]?.[0]).toContain("status: error");
    expect(runCompletion.mock.calls[0]?.[0]).toContain("is_error: true");
    expect(runCompletion.mock.calls[1]?.[0]).toMatch(/Artifact failure did not create/i);
  });

  it("retries malformed Edit JSON and returns the corrected call as tool_use", async () => {
    const malformed = String.raw`{"tool_call":{"name":"Edit","arguments":{"file_path":"server.js","old_string":"// Middleware\napp.use(cors());\app.use(express.json())","new_string":"app.use(cors());"}}}`;
    const corrected = JSON.stringify({
      tool_call: {
        name: "Edit",
        arguments: {
          file_path: "server.js",
          old_string: "// Middleware\napp.use(cors());\napp.use(express.json())",
          new_string: "app.use(cors());",
        },
      },
    });
    const { client, runCompletion } = actionClient([malformed, corrected]);

    const result = await client.complete(actionRequest([{
      role: "user",
      parts: [{ type: "text", text: "измени middleware в server.js" }],
    }]), actionState());

    expect(result.content).toBe("");
    expect(result.toolCall).toMatchObject({ name: "Edit", args: { file_path: "server.js" } });
    expect(runCompletion).toHaveBeenCalledTimes(2);
    expect(runCompletion.mock.calls[1]?.[0]).toMatch(/malformed/i);
    expect(runCompletion.mock.calls[1]?.[0]).toMatch(/was NOT executed/i);
    expect(runCompletion.mock.calls[1]?.[0]).toMatch(/backslash/i);
  });

  it("never leaks malformed raw tool JSON after bounded retries", async () => {
    const malformed = String.raw`{"tool_call":{"name":"Edit","arguments":{"file_path":"server.js","old_string":"a\app.use()","new_string":"b"}}}`;
    const { client, runCompletion } = actionClient([malformed, malformed, malformed]);

    let caught: unknown;
    try {
      await client.complete(actionRequest([{
        role: "user",
        parts: [{ type: "text", text: "измени server.js" }],
      }]), actionState());
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "TOOL_CALL_REQUIRED", status: 502 });
    expect((caught as Error).message).toMatch(/malformed tool-call syntax/i);
    expect((caught as Error).message).not.toContain('{"tool_call"');
    expect((caught as Error).message.trim().length).toBeGreaterThan(0);
    expect(runCompletion).toHaveBeenCalledTimes(COMPLETION_GUARD_MAX_ATTEMPTS);
  });

  it("allows a JSON tool-call example in an informational answer", async () => {
    const answer = 'Пример: {"tool_call":{"name":"Edit","arguments":{"file_path":"server.js"}}}';
    const { client, runCompletion } = actionClient([answer]);

    const result = await client.complete(actionRequest([{
      role: "user",
      parts: [{ type: "text", text: "что означает JSON-пример вызова Edit?" }],
    }]), actionState());

    expect(result.content).toBe(answer);
    expect(result.toolCall).toBeUndefined();
    expect(runCompletion).toHaveBeenCalledTimes(1);
  });

  it("retries malformed action syntax after a successful tool_result when work remains", async () => {
    const malformed = String.raw`{"tool_call":{"name":"Edit","arguments":{"file_path":"server.js","old_string":"a\app.listen()","new_string":"b"}}}`;
    const corrected = '{"tool_call":{"name":"Bash","arguments":{"command":"node server.js"}}}';
    const { client, runCompletion } = actionClient([malformed, corrected]);

    const result = await client.complete(actionRequest([
      { role: "user", parts: [{ type: "text", text: "создай server.js и запусти приложение" }] },
      { role: "assistant", parts: [{
        type: "tool_use",
        toolCall: { id: "call_write", type: "function", name: "Write", arguments: { file_path: "server.js", content: "app" } },
      }] },
      { role: "user", parts: [{
        type: "tool_result",
        toolResult: { toolUseId: "call_write", content: "File written", isError: false },
      }] },
    ]), actionState());

    expect(result.toolCall).toMatchObject({ name: "Bash", args: { command: "node server.js" } });
    expect(runCompletion).toHaveBeenCalledTimes(2);
    expect(runCompletion.mock.calls[1]?.[0]).toMatch(/malformed/i);
    expect(runCompletion.mock.calls[1]?.[0]).toContain('Still-unverified action kinds: ["launch"]');
  });

  it("recovers an unobservable exact-count verification with a deterministic GET instead of replaying the POST", async () => {
    const title = "INCONCLUSIVE-CHECK — ёжик №731";
    const description = "Проверка нечитаемого count без повторной мутации";
    const prompt = `Создай ровно одну новую задачу:\ntitle:\n${title}\ndescription:\n${description}\nЗатем проверь итог через API.`;
    const post = `node -e "fetch('http://127.0.0.1:3000/api/tasks', {method:'POST', body: JSON.stringify({title:'${title}', description:'${description}'})})"`;
    const messages: CanonicalMessage[] = [
      { role: "user", parts: [{ type: "text", text: prompt }] },
      { role: "assistant", parts: [{ type: "tool_use", toolCall: { id: "post", type: "function", name: "Bash", arguments: { command: post } } }] },
      { role: "user", parts: [{ type: "tool_result", toolResult: { toolUseId: "post", content: "created" } }] },
      { role: "assistant", parts: [{ type: "tool_use", toolCall: { id: "api", type: "function", name: "Bash", arguments: { command: "curl http://127.0.0.1:3000/api/tasks" } } }] },
      { role: "user", parts: [{ type: "tool_result", toolResult: { toolUseId: "api", content: `Задача найдена: ${title} / ${description}. Всего задач: 1.` } }] },
    ];
    const { client, runCompletion } = actionClient([
      "Готово: задача создана и проверена.",
      '{"tool_call":{"name":"Bash","arguments":{"command":"curl -s http://127.0.0.1:3000/api/tasks"}}}',
    ]);

    const result = await client.complete(actionRequest(messages), actionState());

    expect(result.toolCall).toEqual({
      name: "Bash",
      args: { command: "curl -s http://127.0.0.1:3000/api/tasks" },
    });
    expect(runCompletion).toHaveBeenCalledTimes(2);
    const retryPrompt = runCompletion.mock.calls[1]?.[0] ?? "";
    expect(retryPrompt).toContain("could not be deterministically counted");
    expect(retryPrompt).toContain("Do NOT repeat an already successful mutation or POST");
    expect(retryPrompt).not.toContain(post);
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
        return new Response(
          'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"OK"}],"status":"FINISHED"}}}\n\n',
          { status: 200 },
        );
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

  it("preserves an ordered Anthropic system block array at the upstream prompt boundary", async () => {
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
        return new Response(
          'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"OK"}],"status":"FINISHED"}}}\n\n',
          { status: 200 },
        );
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
      const request = normalizeAnthropic({
        model: "deepseek-v4-flash",
        stream: false,
        system: [
          { type: "text", text: "SYS-A" },
          { type: "text", text: "  SYS-B\nINNER  ", cache_control: { type: "ephemeral" } },
          { type: "text", text: "SYS-C-ёжик" },
        ],
        messages: [
          { role: "user", content: [{ type: "text", text: "USER-A" }] },
          { role: "assistant", content: [{ type: "text", text: "ASSISTANT-A" }] },
          { role: "user", content: [{ type: "text", text: "USER-B" }] },
        ],
      }, {});
      const state: UpstreamSessionState = {
        chatSessionId: "test-session",
        parentMessageId: null,
        history: [],
        updatedAt: 0,
      };

      await client.complete(request, state);

      expect(completionPrompt).toBe(
        "System: SYS-A\n  SYS-B\nINNER  \nSYS-C-ёжик\n\nuser: USER-A\nassistant: ASSISTANT-A\nuser: USER-B",
      );
      expect(completionPrompt).not.toContain('"type":"text"');
      expect(completionPrompt).not.toContain("cache_control");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("D22 PB06 final absence verification", () => {
  const tools = ["Write", "Edit", "Read", "Cat", "Bash"];
  const prompt = "Create report.txt. Then edit the same file. Then delete the same file. Finally verify that report.txt does not exist.";
  const frozenPrompt = "Create report.txt. Then edit the same file. Then delete the same file. Finally verify that report.txt no longer exists.";
  const msg = (role: "user" | "assistant", parts: unknown[]): CanonicalMessage =>
    ({ role, parts }) as CanonicalMessage;
  const use = (id: string, name: string, argumentsValue: Record<string, unknown>): CanonicalMessage =>
    msg("assistant", [{ type: "tool_use", toolCall: { id, type: "function", name, arguments: argumentsValue } }]);
  const result = (id: string, content: string, isError = false): CanonicalMessage =>
    msg("user", [{ type: "tool_result", toolResult: { toolUseId: id, content, isError } }]);
  const absenceCall = (target = "report.txt") => ({
    id: "d22-verify",
    type: "function" as const,
    name: "Bash",
    arguments: { command: `test ! -e ${target}` },
  });
  const beforeAbsence = (userPrompt = prompt): CanonicalMessage[] => [
    msg("user", [{ type: "text", text: userPrompt }]),
    use("d22-write", "Write", { file_path: "report.txt", content: "ALPHA" }),
    result("d22-write", "report.txt created"),
    use("d22-edit", "Edit", { file_path: "report.txt", old_string: "ALPHA", new_string: "BETA" }),
    result("d22-edit", "report.txt edited"),
    use("d22-delete", "Bash", { command: "rm report.txt" }),
    result("d22-delete", "report.txt deleted"),
  ];
  const withBashResult = (
    command: string,
    content: string,
    isError = false,
    userPrompt = prompt,
  ): CurrentToolCycleEvidence =>
    inspectCurrentToolCycle([
      ...beforeAbsence(userPrompt),
      use("d22-verify", "Bash", { command }),
      result("d22-verify", content, isError),
    ], tools);

  it("keeps three mutations separate and marks final verification as expected absent", () => {
    const obligations = inferToolObligations(prompt, tools);
    expect(obligations.filter(obligation => obligation.kind === "file_mutation")).toHaveLength(3);
    expect(obligations.find(obligation => obligation.kind === "file_verification")).toMatchObject({
      argumentLiterals: ["report.txt"],
      expectedFileState: "absent",
    });
  });

  it.each([
    "Verify that report.txt does not exist.",
    "Verify that report.txt doesn't exist.",
    "Verify that report.txt no longer exists.",
    "Verify that report.txt no longer exist.",
  ])("marks supported absence wording in %s", userPrompt => {
    expect(inferToolObligations(userPrompt, tools)).toContainEqual(expect.objectContaining({
      kind: "file_verification",
      argumentLiterals: ["report.txt"],
      expectedFileState: "absent",
    }));
  });

  it("does not create absence state for unrelated informational wording", () => {
    expect(inferToolObligations("Explain what 'report.txt no longer exists' means.", tools))
      .not.toContainEqual(expect.objectContaining({ expectedFileState: "absent" }));
  });

  it("completes the exact frozen PB06 no-longer-exists cycle", () => {
    const evidence = withBashResult("test ! -e report.txt", "report.txt absent", false, frozenPrompt);
    expect(evidence.fulfilledObligationIds).toEqual([
      "file_mutation#1",
      "file_mutation#2",
      "file_mutation#3",
      "file_verification",
    ]);
    expect(evidence.missingObligations).toEqual([]);
    expect(shouldRetry(true, null, "PB06-OK", "", tools, evidence)).toBe(false);
  });

  it("admits the exact target-matching absence predicate", () => {
    const evidence = inspectCurrentToolCycle(beforeAbsence(), tools);
    expect(isToolCallSemanticallyAdmissible(absenceCall(), evidence)).toBe(true);
  });

  it("fulfills PB06 and allows final only after the successful absence result", () => {
    const evidence = withBashResult("test ! -e report.txt", "report.txt absent");
    expect(evidence.fulfilledObligationIds).toEqual([
      "file_mutation#1",
      "file_mutation#2",
      "file_mutation#3",
      "file_verification",
    ]);
    expect(evidence.missingObligations).toEqual([]);
    expect(shouldRetry(true, null, "PB06-OK", "", tools, evidence)).toBe(false);
  });

  it("does not fulfill absence verification after a failed predicate", () => {
    const evidence = withBashResult("test ! -e report.txt", "report.txt still exists", true);
    expect(evidence.missingObligations.map(obligation => obligation.id)).toContain("file_verification");
  });

  it("does not fulfill absence verification with unrelated successful Bash", () => {
    const evidence = withBashResult("echo OK", "OK");
    expect(evidence.missingObligations.map(obligation => obligation.id)).toContain("file_verification");
  });

  it("requires an exact absence target rather than a substring match", () => {
    const evidence = withBashResult("test ! -e other-report.txt", "other-report.txt absent");
    expect(evidence.missingObligations.map(obligation => obligation.id)).toContain("file_verification");
    expect(isToolCallSemanticallyAdmissible(absenceCall("other-report.txt"), inspectCurrentToolCycle(beforeAbsence(), tools)))
      .toBe(false);
  });

  it("does not accept the opposite-state test -e predicate", () => {
    const evidence = withBashResult("test -e report.txt", "report.txt exists");
    expect(evidence.missingObligations.map(obligation => obligation.id)).toContain("file_verification");
  });

  it("does not let an absence predicate prove a requested presence", () => {
    const presencePrompt = "Verify that report.txt exists.";
    const messages = [
      msg("user", [{ type: "text", text: presencePrompt }]),
      use("presence", "Bash", { command: "test ! -e report.txt" }),
      result("presence", "report.txt absent"),
    ];
    const evidence = inspectCurrentToolCycle(messages, tools);
    expect(evidence.obligations.find(obligation => obligation.kind === "file_verification")?.expectedFileState)
      .toBeUndefined();
    expect(evidence.missingObligations.map(obligation => obligation.id)).toContain("file_verification");
    expect(isToolCallSemanticallyAdmissible(absenceCall(), inspectCurrentToolCycle(messages.slice(0, 1), tools)))
      .toBe(false);
  });

  it("keeps a missing-file Read as failed evidence", () => {
    const evidence = inspectCurrentToolCycle([
      ...beforeAbsence(),
      use("missing-read", "Read", { file_path: "report.txt" }),
      result("missing-read", "File not found: report.txt", true),
    ], tools);
    expect(evidence.missingObligations.map(obligation => obligation.id)).toContain("file_verification");
  });

  it("keeps masked and structured failure signals from fulfilling absence", () => {
    const masked = withBashResult("test ! -e report.txt", "File not found: report.txt");
    const structured = withBashResult("test ! -e report.txt", JSON.stringify({ error: "probe failed" }));
    expect(masked.missingObligations.map(obligation => obligation.id)).toContain("file_verification");
    expect(structured.missingObligations.map(obligation => obligation.id)).toContain("file_verification");
  });

  it.each(["Read", "Cat"])("preserves ordinary %s verification behavior", toolName => {
    const ordinaryPrompt = "Read and verify report.txt.";
    const evidence = inspectCurrentToolCycle([
      msg("user", [{ type: "text", text: ordinaryPrompt }]),
      use("ordinary-read", toolName, { file_path: "report.txt" }),
      result("ordinary-read", "report.txt contents"),
    ], tools);
    expect(evidence.fulfilledObligationIds).toContain("file_verification");
  });
});

describe("D23 ordered PB06 obligation model", () => {
  const toolNames = ["Write", "Edit", "Read", "Cat", "Bash"];
  const tools = toolNames.map(name => ({
    name,
    description: name,
    inputSchema: { type: "object", additionalProperties: true },
  }));
  const prompt = [
    "Используя инструменты, выполни строго по порядку:",
    "",
    "1. Создай файл report.txt с содержимым PB06-INITIAL.",
    "2. Через Edit замени PB06-INITIAL на PB06-EDITED.",
    "3. Через Bash выполни `rm report.txt`.",
    "4. Через Bash выполни `test ! -e report.txt`, чтобы проверить, что report.txt no longer exists.",
    "",
    "Только после успешного выполнения всех четырёх шагов ответь ровно:",
    "PB06-OK",
  ].join("\n");
  const msg = (role: "user" | "assistant", parts: unknown[]): CanonicalMessage => ({ role, parts }) as CanonicalMessage;
  const use = (id: string, name: string, args: Record<string, unknown>): CanonicalMessage => msg("assistant", [{
    type: "tool_use",
    toolCall: { id, type: "function", name, arguments: args },
  }]);
  const result = (id: string, content = "ok", isError = false): CanonicalMessage => msg("user", [{
    type: "tool_result",
    toolResult: { toolUseId: id, content, isError },
  }]);
  const write = { id: "pb06-write", type: "function" as const, name: "Write", arguments: { file_path: "report.txt", content: "PB06-INITIAL" } };
  const edit = { id: "pb06-edit", type: "function" as const, name: "Edit", arguments: { file_path: "report.txt", old_string: "PB06-INITIAL", new_string: "PB06-EDITED" } };
  const remove = { id: "pb06-delete", type: "function" as const, name: "Bash", arguments: { command: "rm report.txt" } };
  const absence = { id: "pb06-absence", type: "function" as const, name: "Bash", arguments: { command: "test ! -e report.txt" } };
  const cycle = (...messages: CanonicalMessage[]): CurrentToolCycleEvidence => inspectCurrentToolCycle([
    msg("user", [{ type: "text", text: prompt }]),
    ...messages,
  ], toolNames);
  const successful = (call: typeof write | typeof edit | typeof remove | typeof absence, content = "ok"): CanonicalMessage[] => [
    use(call.id, call.name, call.arguments),
    result(call.id, content),
  ];

  it("infers exactly four ordered semantic PB06 steps without duplicate generic kinds", () => {
    expect(inferToolObligations(prompt, toolNames)).toEqual([
      expect.objectContaining({ kind: "file_mutation", action: "create", target: "report.txt", orderedGroup: "file_actions", ordinal: 1 }),
      expect.objectContaining({ kind: "file_mutation", action: "edit", target: "report.txt", orderedGroup: "file_actions", ordinal: 2, requiredToolName: "Edit" }),
      expect.objectContaining({ kind: "file_mutation", action: "delete", target: "report.txt", orderedGroup: "file_actions", ordinal: 3, requiredToolName: "Bash", commandSemantic: "delete_file" }),
      expect.objectContaining({ kind: "file_verification", action: "verify", target: "report.txt", orderedGroup: "file_actions", ordinal: 4, requiredToolName: "Bash", commandSemantic: "verify_absent", expectedFileState: "absent" }),
    ]);
    expect(inferToolObligations(prompt, toolNames).map(obligation => obligation.kind)).not.toContain("test_execution");
    expect(inferToolObligations(prompt, toolNames).map(obligation => obligation.kind)).not.toContain("command_execution");
  });

  it("admits only Write before the ordered sequence begins", () => {
    const evidence = cycle();
    expect(isToolCallSemanticallyAdmissible(write, evidence)).toBe(true);
    expect(isToolCallSemanticallyAdmissible(edit, evidence)).toBe(false);
    expect(isToolCallSemanticallyAdmissible(remove, evidence)).toBe(false);
    expect(isToolCallSemanticallyAdmissible(absence, evidence)).toBe(false);
  });

  it("admits Edit only after successful Write", () => {
    const evidence = cycle(...successful(write));
    expect(evidence.fulfilledObligationIds).toEqual(["file_mutation#1"]);
    expect(isToolCallSemanticallyAdmissible(edit, evidence)).toBe(true);
    expect(isToolCallSemanticallyAdmissible(remove, evidence)).toBe(false);
  });

  it("admits delete only after successful Write and Edit", () => {
    const evidence = cycle(...successful(write), ...successful(edit));
    expect(evidence.fulfilledObligationIds).toEqual(["file_mutation#1", "file_mutation#2"]);
    expect(isToolCallSemanticallyAdmissible(remove, evidence)).toBe(true);
    expect(isToolCallSemanticallyAdmissible(absence, evidence)).toBe(false);
  });

  it("admits absence verification only after successful delete", () => {
    const evidence = cycle(...successful(write), ...successful(edit), ...successful(remove));
    expect(evidence.fulfilledObligationIds).toEqual(["file_mutation#1", "file_mutation#2", "file_mutation#3"]);
    expect(isToolCallSemanticallyAdmissible(absence, evidence)).toBe(true);
  });

  it("completes Write Edit delete verify and allows the final", () => {
    const evidence = cycle(
      ...successful(write), ...successful(edit), ...successful(remove), ...successful(absence, "report.txt absent"),
    );
    expect(evidence.fulfilledObligationIds).toEqual([
      "file_mutation#1", "file_mutation#2", "file_mutation#3", "file_verification",
    ]);
    expect(evidence.missingObligations).toEqual([]);
    expect(shouldRetry(true, null, "PB06-OK", "", toolNames, evidence)).toBe(false);
  });

  it("does not advance the sequence after a failed current step", () => {
    const failedWrite = cycle(use(write.id, write.name, write.arguments), result(write.id, "write failed", true));
    expect(failedWrite.fulfilledObligationIds).toEqual([]);
    expect(failedWrite.missingObligations[0]).toMatchObject({ action: "create", ordinal: 1 });
    expect(isToolCallSemanticallyAdmissible(edit, failedWrite)).toBe(false);
  });

  it("does not let a successful out-of-order action fulfill the current ordinal", () => {
    const evidence = cycle(...successful(edit));
    expect(evidence.fulfilledObligationIds).toEqual([]);
    expect(evidence.missingObligations).toHaveLength(4);
  });

  it("uses one rm result for exactly the delete step", () => {
    const evidence = cycle(...successful(write), ...successful(edit), ...successful(remove));
    expect(evidence.fulfilledObligationIds).toEqual(["file_mutation#1", "file_mutation#2", "file_mutation#3"]);
    expect(evidence.missingObligations.map(obligation => obligation.action)).toEqual(["verify"]);
  });

  it("uses one absence result for exactly the verification step with no duplicate Bash requirement", () => {
    const evidence = cycle(
      ...successful(write), ...successful(edit), ...successful(remove), ...successful(absence, "absent"),
    );
    expect(evidence.missingObligations).toEqual([]);
    expect(evidence.obligations.filter(obligation => obligation.requiredToolName === "Bash")).toHaveLength(2);
  });

  it("keeps standalone Edit on an existing file unordered and admissible", () => {
    const standalone = inspectCurrentToolCycle([msg("user", [{ type: "text", text: "Edit existing.txt." }])], toolNames);
    expect(standalone.obligations[0]).toMatchObject({ action: "edit", target: "existing.txt" });
    expect(standalone.obligations[0]?.orderedGroup).toBeUndefined();
    expect(isToolCallSemanticallyAdmissible({ ...edit, arguments: { file_path: "existing.txt", old_string: "A", new_string: "B" } }, standalone)).toBe(true);
  });

  it("keeps independent unordered mutations free of artificial dependencies", () => {
    const unordered = inspectCurrentToolCycle([msg("user", [{ type: "text", text: "Create a.txt and edit b.txt." }])], toolNames);
    expect(unordered.obligations.every(obligation => obligation.orderedGroup === undefined)).toBe(true);
    expect(isToolCallSemanticallyAdmissible({ ...edit, arguments: { file_path: "b.txt", old_string: "A", new_string: "B" } }, unordered)).toBe(true);
  });

  it("maps ordered Write then Read to create and admits Write", () => {
    const userPrompt = "Write a.txt with X. Then read a.txt.";
    const evidence = inspectCurrentToolCycle([msg("user", [{ type: "text", text: userPrompt }])], toolNames);
    expect(evidence.obligations).toEqual([
      expect.objectContaining({ kind: "file_mutation", action: "create", target: "a.txt", ordinal: 1 }),
      expect.objectContaining({ kind: "file_verification", action: "verify", target: "a.txt", ordinal: 2 }),
    ]);
    expect(isToolCallSemanticallyAdmissible({
      ...write,
      arguments: { file_path: "a.txt", content: "X" },
    }, evidence)).toBe(true);
  });

  it.each([
    "Запиши файл a.txt с содержимым X. Затем прочитай a.txt.",
    "Сохрани файл a.txt с содержимым X. Затем прочитай a.txt.",
  ])("maps supported ordered RU write/save wording to create: %s", userPrompt => {
    const evidence = inspectCurrentToolCycle([msg("user", [{ type: "text", text: userPrompt }])], toolNames);
    expect(evidence.obligations[0]).toMatchObject({ kind: "file_mutation", action: "create", target: "a.txt", ordinal: 1 });
    expect(isToolCallSemanticallyAdmissible({
      ...write,
      arguments: { file_path: "a.txt", content: "X" },
    }, evidence)).toBe(true);
  });

  it("keeps explicit Edit and clearly existing-file Write semantics as edit", () => {
    for (const userPrompt of [
      "Edit existing a.txt. Then read a.txt.",
      "Write changes to existing a.txt. Then read a.txt.",
    ]) {
      const evidence = inspectCurrentToolCycle([msg("user", [{ type: "text", text: userPrompt }])], toolNames);
      expect(evidence.obligations[0]).toMatchObject({ kind: "file_mutation", action: "edit", target: "a.txt", ordinal: 1 });
      expect(isToolCallSemanticallyAdmissible({
        ...edit,
        arguments: { file_path: "a.txt", old_string: "A", new_string: "B" },
      }, evidence)).toBe(true);
    }
  });

  it("preserves an independent command next to semantic rm", () => {
    const userPrompt = "Execute the command git status. Then via Bash execute `rm report.txt`.";
    const obligations = inferToolObligations(userPrompt, toolNames);
    expect(obligations).toEqual([
      expect.objectContaining({ kind: "command_execution", argumentLiterals: ["git status"] }),
      expect.objectContaining({ kind: "file_mutation", action: "delete", target: "report.txt", commandSemantic: "delete_file" }),
    ]);
  });

  it("does not let rm skip an independent git status command", () => {
    const userPrompt = "Execute the command git status. Then via Bash execute `rm report.txt`.";
    const afterRemove = inspectCurrentToolCycle([
      msg("user", [{ type: "text", text: userPrompt }]),
      use("mixed-rm", "Bash", { command: "rm report.txt" }),
      result("mixed-rm"),
    ], toolNames);
    expect(afterRemove.fulfilledObligationIds).toEqual(["file_mutation"]);
    expect(afterRemove.missingObligations).toEqual([
      expect.objectContaining({ kind: "command_execution", argumentLiterals: ["git status"] }),
    ]);
    expect(isToolCallSemanticallyAdmissible({
      id: "mixed-git",
      type: "function",
      name: "Bash",
      arguments: { command: "git status" },
    }, afterRemove)).toBe(true);
  });

  it("keeps semantic Bash steps free of duplicate generic command obligations", () => {
    expect(inferToolObligations("Via Bash execute `rm report.txt`.", toolNames).map(obligation => obligation.kind))
      .toEqual(["file_mutation"]);
    expect(inferToolObligations(
      "Via Bash execute `test ! -e report.txt` to verify report.txt no longer exists.",
      toolNames,
    ).map(obligation => obligation.kind)).toEqual(["file_verification"]);
    expect(inferToolObligations(prompt, toolNames).map(obligation => obligation.kind))
      .toEqual(["file_mutation", "file_mutation", "file_mutation", "file_verification"]);
  });

  it("keeps a standalone command-only request", () => {
    expect(inferToolObligations("Run git status.", toolNames).map(obligation => obligation.kind)).toEqual([
      "command_execution",
    ]);
  });

  it.each([
    "Run the project tests.",
    "Через Bash выполни `npm test`.",
    "Через Bash выполни `npx jest`.",
    "Через Bash выполни `npx vitest`.",
    "Через Bash выполни `pytest`.",
  ])("preserves genuine software test execution for %s", userPrompt => {
    const kinds = inferToolObligations(userPrompt, toolNames).map(obligation => obligation.kind);
    expect(kinds).toContain("test_execution");
    expect(kinds).not.toContain("command_execution");
  });

  it.each([
    "Через Bash выполни `node -e \"fs.unlinkSync('a.txt')\"`.",
    "Через Bash выполни `node -e \"process.stdout.write('a.txt')\"`.",
    "Через Bash выполни `node -e \"fs.readFileSync('a.txt')\"`.",
  ])("keeps arbitrary command-local file APIs masked for %s", userPrompt => {
    const kinds = inferToolObligations(userPrompt, toolNames).map(obligation => obligation.kind);
    expect(kinds).toEqual(["command_execution"]);
  });

  it("limits retry guidance to the next executable ordered step", async () => {
    const client = new DeepSeekClient({
      baseUrl: "https://example.com",
      auth: { token: "test-token", cookie: "test-cookie" },
      sessionManager: {} as never,
      solver: {} as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
      redactor: { addSecret: () => {}, redactText: (text: string) => text } as never,
      timeoutMs: 10_000,
      maxRetries: 0,
    });
    const outputs = [
      '{"tool_call":{"name":"Edit","arguments":{"file_path":"report.txt","old_string":"PB06-INITIAL","new_string":"PB06-EDITED"}}}',
      '{"tool_call":{"name":"Write","arguments":{"file_path":"report.txt","content":"PB06-INITIAL"}}}',
    ];
    const runCompletion = vi.fn(async (_prompt: string) => ({
      content: outputs.shift() ?? "",
      reasoning: "",
      candidateMessageId: null,
    }));
    Object.defineProperty(client, "runCompletion", { value: runCompletion });
    const response = await client.complete({
      model: "deepseek-v4-flash",
      stream: false,
      system: "",
      messages: [msg("user", [{ type: "text", text: prompt }])],
      tools,
    }, {
      chatSessionId: "d23-session",
      parentMessageId: null,
      history: [],
      updatedAt: 0,
    });
    expect(response.toolCall?.name).toBe("Write");
    expect(runCompletion).toHaveBeenCalledTimes(2);
    expect(runCompletion.mock.calls[1]?.[0]).not.toContain("using Edit");
    expect(runCompletion.mock.calls[1]?.[0]).not.toContain("requested file is absent");
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
