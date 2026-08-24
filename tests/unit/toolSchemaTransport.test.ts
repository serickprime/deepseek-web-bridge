import { describe, expect, it, vi } from "vitest";
import type { CanonicalRequest, CanonicalTool } from "../../src/api/canonical.js";
import { CompletionHandler } from "../../src/api/handler.js";
import { DeepSeekClient } from "../../src/deepseek/client.js";
import { SessionStore, type UpstreamSessionState } from "../../src/sessions/sessionStore.js";
import type { ProtocolStream } from "../../src/server/protocolStream.js";
import { inspectToolCallFromOutput } from "../../src/tools/toolParser.js";
import {
  buildToolCatalog,
  buildToolPrompt,
  TOOL_CATALOG_MAX_BYTES,
} from "../../src/tools/toolPrompt.js";
import { BridgeError } from "../../src/utils/errors.js";

const SCHEMA_PREFIX = "  Input schema: ";

function embeddedSchemas(text: string): unknown[] {
  return text
    .split(/\r?\n/)
    .filter(line => line.startsWith(SCHEMA_PREFIX))
    .map(line => JSON.parse(line.slice(SCHEMA_PREFIX.length)) as unknown);
}

function tool(name: string, inputSchema: Record<string, unknown>, description = `${name} description`): CanonicalTool {
  return { name, description, inputSchema };
}

function tools(count: number): CanonicalTool[] {
  return Array.from({ length: count }, (_, index) => tool(`Tool${String(index + 1).padStart(2, "0")}`, {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  }));
}

function request(requestTools: CanonicalTool[], text = "Explain JSON schemas briefly."): CanonicalRequest {
  return {
    model: "deepseek-v4-flash",
    stream: false,
    system: "",
    messages: [{ role: "user", parts: [{ type: "text", text }] }],
    tools: requestTools,
  };
}

function state(): UpstreamSessionState {
  return { chatSessionId: "d11-session", parentMessageId: null, history: [], updatedAt: 0 };
}

function clientWithOutputs(outputs: Array<{ content: string; reasoning?: string; candidateMessageId?: number | null }>, logText: string[] = []): {
  client: DeepSeekClient;
  prompts: string[];
} {
  const logger = {
    info: (event: string, fields?: Record<string, unknown>) => logText.push(JSON.stringify({ event, fields })),
    warn: (event: string, fields?: Record<string, unknown>) => logText.push(JSON.stringify({ event, fields })),
    error: (event: string, fields?: Record<string, unknown>) => logText.push(JSON.stringify({ event, fields })),
    child: () => logger,
  };
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
  const prompts: string[] = [];
  Object.defineProperty(client, "runCompletion", {
    value: async (prompt: string) => {
      prompts.push(prompt);
      const output = queue.shift() ?? { content: "OK", candidateMessageId: null };
      return {
        content: output.content,
        reasoning: output.reasoning ?? "",
        candidateMessageId: output.candidateMessageId ?? null,
      };
    },
  });
  return { client, prompts };
}

function budgetTool(fillerBytes: number): CanonicalTool {
  return tool("BudgetProbe", {
    type: "object",
    description: "x".repeat(fillerBytes),
  }, "Budget probe");
}

function exactBudgetTool(): CanonicalTool {
  const baseBytes = buildToolCatalog([budgetTool(0)]).utf8Bytes;
  return budgetTool(TOOL_CATALOG_MAX_BYTES - baseBytes);
}

function streamStub(): ProtocolStream {
  return {
    start: vi.fn(),
    push: vi.fn(),
    finish: vi.fn(),
    fail: vi.fn(),
  } as unknown as ProtocolStream;
}

describe("D11 full tool-schema transport", () => {
  it("preserves root type, required, property types, and enums", () => {
    const schema = {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["safe", "fast"] },
        retries: { type: "integer", minimum: 0 },
        enabled: { type: "boolean" },
      },
      required: ["mode", "enabled"],
      additionalProperties: false,
    };

    expect(embeddedSchemas(buildToolPrompt([tool("Configure", schema)]))).toEqual([schema]);
  });

  it("preserves nested object requirements, descriptions, and additionalProperties", () => {
    const schema = {
      type: "object",
      properties: {
        config: {
          type: "object",
          description: "Nested configuration",
          properties: {
            owner: { type: "string", description: "Configuration owner" },
          },
          required: ["owner"],
          additionalProperties: false,
        },
      },
      required: ["config"],
      additionalProperties: false,
    };

    expect(embeddedSchemas(buildToolPrompt([tool("Nested", schema)]))).toEqual([schema]);
  });

  it("preserves array item schemas without truncation", () => {
    const schema = {
      type: "object",
      properties: {
        steps: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: { command: { type: "string" }, timeout: { type: "number" } },
            required: ["command"],
          },
        },
      },
      required: ["steps"],
    };

    expect(embeddedSchemas(buildToolPrompt([tool("RunSteps", schema)]))).toEqual([schema]);
  });

  it("preserves root oneOf and $defs references", () => {
    const schema = {
      $defs: {
        path: { type: "string", minLength: 1 },
      },
      oneOf: [
        { type: "object", properties: { file: { $ref: "#/$defs/path" } }, required: ["file"] },
        { type: "object", properties: { directory: { $ref: "#/$defs/path" } }, required: ["directory"] },
      ],
    };

    expect(embeddedSchemas(buildToolPrompt([tool("Locate", schema)]))).toEqual([schema]);
  });

  it("round-trips Unicode, quotes, newlines, and escaped Windows paths", () => {
    const schema = {
      type: "object",
      description: "Путь для ёжика\nс кавычкой \" и slash \\",
      properties: {
        path: { type: "string", examples: ["D:\\Проекты\\Тестовая папка\\ёжик"] },
      },
      required: ["path"],
    };

    const catalog = buildToolCatalog([tool("UnicodePath", schema)]);
    expect(embeddedSchemas(catalog.text)).toEqual([schema]);
    expect(catalog.text).toContain("\\n");
    expect(catalog.text).toContain("D:\\\\Проекты");
  });

  it("preserves every occurrence, order, and duplicate schema independently", () => {
    const input = [
      tool("Duplicate", { type: "object", properties: { first: { type: "string" } } }),
      tool("Duplicate", { type: "object", properties: { second: { type: "number" } } }),
      tool("Last", { type: "object", required: ["done"], properties: { done: { type: "boolean" } } }),
    ];
    const catalog = buildToolCatalog(input);

    expect(catalog.available).toEqual(input);
    expect(embeddedSchemas(catalog.text)).toEqual(input.map(item => item.inputSchema));
  });

  it("accepts an exact 131072-byte catalog and rejects +1", () => {
    const exact = exactBudgetTool();
    const catalog = buildToolCatalog([exact]);

    expect(catalog.utf8Bytes).toBe(131_072);
    expect(() => buildToolCatalog([budgetTool(String((exact.inputSchema.description as string)).length + 1)]))
      .toThrowError(expect.objectContaining({ code: "REQUEST_TOO_LARGE", status: 413 }));
  });

  it.each([25, 30, 34, 38, 40])("supports a dynamic %i-tool catalog within budget", count => {
    const input = tools(count);
    const catalog = buildToolCatalog(input);

    expect(catalog.available).toHaveLength(count);
    expect(embeddedSchemas(catalog.text)).toEqual(input.map(item => item.inputSchema));
    expect(catalog.utf8Bytes).toBeLessThanOrEqual(TOOL_CATALOG_MAX_BYTES);
  });

  it("filters Artifact before schema serialization and budget accounting", () => {
    const hugeArtifact = tool("Artifact", { description: "x".repeat(TOOL_CATALOG_MAX_BYTES + 1) });
    const supported = tools(38);
    const catalog = buildToolCatalog([hugeArtifact, ...supported]);

    expect(catalog.unavailableNames).toEqual(["Artifact"]);
    expect(catalog.available).toEqual(supported);
    expect(embeddedSchemas(catalog.text)).toEqual(supported.map(item => item.inputSchema));
    expect(catalog.text).not.toContain("Artifact");
  });

  it("fully describes Tool33+ while preserving the D7 catalog identity", () => {
    const input = tools(40);
    const catalog = buildToolCatalog(input);

    expect(catalog.text).toContain("- Tool33");
    expect(catalog.text).toContain("- Tool40");
    expect(embeddedSchemas(catalog.text)).toEqual(input.map(item => item.inputSchema));
  });

  it("puts the complete catalog in the initial upstream prompt", async () => {
    const schema = { type: "object", properties: { mode: { type: "string", enum: ["D11_INITIAL"] } }, required: ["mode"] };
    const input = [tool("InitialSchema", schema)];
    const catalog = buildToolCatalog(input).text;
    const { client, prompts } = clientWithOutputs([{ content: "Schema explained." }]);

    await client.complete(request(input), state());

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(catalog);
    expect(embeddedSchemas(prompts[0]!)).toEqual([schema]);
  });

  it("repeats the identical complete catalog in a repair prompt without a candidate parent", async () => {
    const schema = { type: "object", properties: { command: { type: "string", enum: ["pwd"] } }, required: ["command"] };
    const input = [tool("Bash", schema, "Run a command")];
    const catalog = buildToolCatalog(input).text;
    const { client, prompts } = clientWithOutputs([
      { content: "I will run pwd now.", candidateMessageId: null },
      { content: JSON.stringify({ tool_call: { name: "Bash", arguments: { command: "pwd" } } }), candidateMessageId: null },
    ]);

    const result = await client.complete(request(input, "Run pwd through Bash."), state());

    expect(result.toolCall?.name).toBe("Bash");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain(catalog);
    expect(prompts[1]).toContain(catalog);
    expect(embeddedSchemas(prompts[1]!)).toEqual([schema]);
  });

  it("keeps the 1000-character description cap without truncating schema", () => {
    const marker = "SCHEMA_AFTER_LONG_DESCRIPTION";
    const catalog = buildToolCatalog([tool("LongDescription", {
      type: "object",
      properties: { value: { type: "string", description: marker } },
    }, "D".repeat(1_100))]);
    const purpose = catalog.text.match(/Purpose: (D+)/)?.[1];

    expect(purpose).toHaveLength(1_000);
    expect(catalog.text).not.toContain("D".repeat(1_001));
    expect(catalog.text).toContain(marker);
  });

  it("rejects an oversized catalog before session creation, upstream completion, or stream exposure", async () => {
    const exact = exactBudgetTool();
    const overflow = budgetTool(String(exact.inputSchema.description as string).length + 1);
    const ensureSession = vi.fn(async () => {});
    const complete = vi.fn(async () => ({ content: "must not run" }));
    const stream = streamStub();
    const handler = new CompletionHandler({
      deepseek: { ensureSession, complete, getAuthGeneration: () => 0 } as never,
      sessionStore: new SessionStore(),
      lineage: { getUpstreamKey: () => undefined, record: async () => {}, removeByUpstreamKey: async () => {} } as never,
      logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    });

    await expect(handler.run({
      protocol: "anthropic",
      request: request([overflow]),
      headers: {},
      body: {},
      stream,
    })).rejects.toMatchObject({ code: "REQUEST_TOO_LARGE", status: 413 });
    expect(ensureSession).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(stream.start).not.toHaveBeenCalled();
  });

  it("keeps unknown-tool parser rejection unchanged", () => {
    const inspection = inspectToolCallFromOutput({
      content: JSON.stringify({ tool_call: { name: "Unknown", arguments: {} } }),
      reasoning: "",
    }, ["Known"]);

    expect(inspection.toolCall).toBeNull();
    expect(inspection.reason).toBe("tool_not_allowed");
  });

  it("PB17 keeps the full schema catalog when a valid tool call is selected from reasoning", async () => {
    const schema = {
      type: "object",
      properties: { path: { type: "string", minLength: 1 } },
      required: ["path"],
      additionalProperties: false,
    };
    const input = [tool("Read", schema, "Read a file")];
    const { client, prompts } = clientWithOutputs([{
      content: "",
      reasoning: JSON.stringify({ tool_call: { name: "Read", arguments: { path: "README.md" } } }),
    }]);

    const result = await client.complete(request(input, "Read README.md."), state());

    expect(result.toolCall).toEqual({ name: "Read", args: { path: "README.md" } });
    expect(embeddedSchemas(prompts[0]!)).toEqual([schema]);
  });

  it("transports array schemas while preserving D12 parser acceptance", () => {
    const schema = {
      type: "object",
      properties: { values: { type: "array", items: { type: "string" } } },
      required: ["values"],
    };
    expect(embeddedSchemas(buildToolCatalog([tool("ArrayTool", schema)]).text)).toEqual([schema]);

    const inspection = inspectToolCallFromOutput({
      content: JSON.stringify({ tool_call: { name: "ArrayTool", arguments: { values: ["one", "two"] } } }),
      reasoning: "",
    }, ["ArrayTool"]);
    expect(inspection.toolCall?.arguments).toEqual({ values: ["one", "two"] });
    expect(inspection.reason).toBe("accepted");
  });

  it("does not emit schema contents into completion telemetry", async () => {
    const schemaMarker = "D11_SCHEMA_LOG_SECRET_MARKER";
    const logs: string[] = [];
    const { client } = clientWithOutputs([{ content: "Done." }], logs);

    await client.complete(request([tool("SafeTelemetry", {
      type: "object",
      description: schemaMarker,
      properties: { value: { type: "string" } },
    })]), state());

    expect(logs.join("\n")).not.toContain(schemaMarker);
  });

  it("fails non-lossless in-memory schemas as INVALID_REQUEST", () => {
    const invalid = { type: "object", unsupported: undefined } as unknown as Record<string, unknown>;

    expect(() => buildToolCatalog([tool("InvalidSchema", invalid)]))
      .toThrowError(expect.objectContaining<Partial<BridgeError>>({ code: "INVALID_REQUEST", status: 400 }));
  });
});
