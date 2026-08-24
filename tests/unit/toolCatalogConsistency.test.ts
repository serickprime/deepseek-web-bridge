import { describe, expect, it, vi } from "vitest";
import type { CanonicalRequest, CanonicalTool } from "../../src/api/canonical.js";
import { CompletionHandler } from "../../src/api/handler.js";
import { DeepSeekClient } from "../../src/deepseek/client.js";
import { SessionStore, type UpstreamSessionState } from "../../src/sessions/sessionStore.js";
import type { ProtocolStream } from "../../src/server/protocolStream.js";
import { inspectToolCallFromOutput } from "../../src/tools/toolParser.js";
import { buildToolPrompt, selectBridgeTools } from "../../src/tools/toolPrompt.js";

function makeTools(count: number): CanonicalTool[] {
  return Array.from({ length: count }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    return {
      name: `Tool${number}`,
      description: `Diagnostic tool ${number}`,
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    };
  });
}

function describedNames(prompt: string): string[] {
  return [...prompt.matchAll(/^- ([^\r\n]+)$/gm)].map(match => match[1]!);
}

function request(tools: CanonicalTool[], messages: CanonicalRequest["messages"]): CanonicalRequest {
  return {
    model: "deepseek-v4-flash",
    stream: false,
    system: "",
    messages,
    tools,
  };
}

function clientWithOutputs(outputs: Array<{ content: string; reasoning?: string }>): {
  client: DeepSeekClient;
  prompts: string[];
} {
  const client = new DeepSeekClient({
    baseUrl: "https://example.invalid",
    auth: { token: "test-token", cookie: "test-cookie" },
    sessionManager: {} as never,
    solver: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    redactor: { addSecret: () => {}, redactText: (text: string) => text } as never,
    timeoutMs: 1_000,
    maxRetries: 0,
  });
  const queue = [...outputs];
  const prompts: string[] = [];
  Object.defineProperty(client, "ensureSession", {
    value: async (state: UpstreamSessionState) => {
      state.chatSessionId = "d7-session";
    },
  });
  Object.defineProperty(client, "runCompletion", {
    value: async (prompt: string) => {
      prompts.push(prompt);
      const output = queue.shift() ?? { content: "", reasoning: "" };
      return {
        content: output.content,
        reasoning: output.reasoning ?? "",
        candidateMessageId: null,
      };
    },
  });
  return { client, prompts };
}

function streamStub(): ProtocolStream {
  return {
    start: vi.fn(),
    push: vi.fn(),
    finish: vi.fn(),
    fail: vi.fn(),
  } as unknown as ProtocolStream;
}

describe("D7 tool catalog consistency", () => {
  it.each([0, 1, 32, 33, 35, 39])("describes every available name for a %i-tool catalog", count => {
    const tools = makeTools(count);
    const selection = selectBridgeTools(tools);
    const prompt = buildToolPrompt(tools);
    const described = describedNames(prompt);

    expect(selection.unavailableNames).toEqual([]);
    expect(described).toEqual(selection.available.map(tool => tool.name));
    expect(new Set(described)).toEqual(new Set(selection.available.map(tool => tool.name)));
    if (count === 0) expect(prompt).toBe("");
  });

  it("describes tools beyond the former 32-tool boundary", () => {
    const prompt = buildToolPrompt(makeTools(39));
    expect(describedNames(prompt)).toEqual(makeTools(39).map(tool => tool.name));
    expect(prompt).toContain("- Tool33");
    expect(prompt).toContain("- Tool35");
    expect(prompt).toContain("- Tool39");
  });

  it.each(["before", "inside", "after"] as const)("keeps Artifact unavailable %s position 32", position => {
    const supported = makeTools(39);
    const artifact: CanonicalTool = { name: "Artifact", description: "Unavailable", inputSchema: {} };
    const tools = position === "before"
      ? [artifact, ...supported]
      : position === "inside"
        ? [...supported.slice(0, 16), artifact, ...supported.slice(16)]
        : [...supported, artifact];

    const selection = selectBridgeTools(tools);
    expect(selection.unavailableNames).toEqual(["Artifact"]);
    expect(selection.available.map(tool => tool.name)).toEqual(supported.map(tool => tool.name));
    expect(describedNames(buildToolPrompt(tools))).toEqual(supported.map(tool => tool.name));
  });

  it("preserves the available catalog order", () => {
    const tools = makeTools(39).reverse();
    expect(describedNames(buildToolPrompt(tools))).toEqual(tools.map(tool => tool.name));
  });

  it("keeps duplicates without allowing them to hide later unique tools", () => {
    const supported = makeTools(39);
    const tools = [supported[0]!, supported[0]!, ...supported.slice(1)];
    const availableNames = selectBridgeTools(tools).available.map(tool => tool.name);
    const described = describedNames(buildToolPrompt(tools));

    expect(described).toEqual(availableNames);
    expect(new Set(described)).toEqual(new Set(supported.map(tool => tool.name)));
    expect(described.at(-1)).toBe("Tool39");
  });

  it("publishes a valid 33+ call as a real handler tool_use", async () => {
    const tools = makeTools(39);
    const { client, prompts } = clientWithOutputs([{
      content: JSON.stringify({ tool_call: { name: "Tool39", arguments: { value: "ok" } } }),
    }]);
    const recorded: string[] = [];
    const stream = streamStub();
    const handler = new CompletionHandler({
      deepseek: client,
      sessionStore: new SessionStore(),
      lineage: {
        getUpstreamKey: () => undefined,
        record: async (callId: string) => { recorded.push(callId); },
        removeByUpstreamKey: async () => {},
      } as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    });

    const result = await handler.run({
      protocol: "anthropic",
      request: request(tools, [{ role: "user", parts: [{ type: "text", text: "Use the suitable tool." }] }]),
      headers: {},
      body: {},
      stream,
    });

    expect(prompts[0]).toContain("- Tool39");
    expect(result.result.toolCalls[0]?.name).toBe("Tool39");
    expect(stream.push).toHaveBeenCalledWith(expect.objectContaining({
      type: "tool_use",
      toolCall: expect.objectContaining({ name: "Tool39" }),
    }));
    expect(recorded).toHaveLength(1);
  });

  it("keeps a 33+ tool_result continuation inside the full described catalog", async () => {
    const tools = makeTools(39);
    const { client, prompts } = clientWithOutputs([{ content: "TOOL39-RESULT-ACCEPTED" }]);
    const state: UpstreamSessionState = {
      chatSessionId: "d7-session",
      parentMessageId: null,
      history: [],
      updatedAt: 0,
    };

    const result = await client.complete(request(tools, [
      { role: "user", parts: [{ type: "text", text: "Summarize the following tool result." }] },
      {
        role: "assistant",
        parts: [{
          type: "tool_use",
          toolCall: { id: "call_tool39", type: "function", name: "Tool39", arguments: { value: "ok" } },
        }],
      },
      {
        role: "user",
        parts: [{
          type: "tool_result",
          toolResult: { toolUseId: "call_tool39", content: "real tool 39 result", isError: false },
        }],
      },
    ]), state);

    expect(result.content).toBe("TOOL39-RESULT-ACCEPTED");
    expect(prompts[0]).toContain("- Tool39");
    expect(prompts[0]).toContain("real tool 39 result");
  });

  it("continues to reject an unknown tool", () => {
    const allowedNames = makeTools(39).map(tool => tool.name);
    const inspection = inspectToolCallFromOutput({
      content: JSON.stringify({ tool_call: { name: "Tool40", arguments: { value: "no" } } }),
      reasoning: "",
    }, allowedNames);

    expect(inspection.toolCall).toBeNull();
    expect(inspection.reason).toBe("tool_not_allowed");
  });

  it("keeps each description capped at 1000 characters", () => {
    const prompt = buildToolPrompt([{
      name: "LongDescription",
      description: "D".repeat(1_100),
      inputSchema: {},
    }]);
    const description = prompt.match(/Purpose: (D+)/)?.[1];
    expect(description).toHaveLength(1_000);
    expect(prompt).not.toContain("D".repeat(1_001));
  });

  it("preserves D7 catalog identity while D11 supplies full nested schema fidelity", () => {
    const prompt = buildToolPrompt([{
      name: "NestedSchema",
      description: "Nested schema control",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", enum: ["D11_ENUM_MARKER"] },
          nested: {
            type: "object",
            properties: { d11_deep_flag: { type: "boolean" } },
            required: ["d11_deep_flag"],
          },
        },
        required: ["path"],
      },
    }]);
    const catalog = prompt.split("\n\n## RULES")[0]!;

    expect(catalog).toContain("Input schema:");
    expect(catalog).toContain("D11_ENUM_MARKER");
    expect(catalog).toContain("d11_deep_flag");
  });
});
