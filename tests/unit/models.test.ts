import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, type AppHandle } from "../../src/app.js";
import type { CanonicalRequest } from "../../src/api/canonical.js";
import {
  bridgeModelList,
  openCodeModelId,
  resolveModelSelection,
} from "../../src/config/modelCapabilities.js";
import { DeepSeekClient } from "../../src/deepseek/client.js";
import type { UpstreamSessionState } from "../../src/sessions/sessionStore.js";

const originalFetch = globalThis.fetch;
const envKeys = ["HOST", "PORT", "DS_DATA_DIR", "DS_AUTH_FILE", "DS_SESSIONS_FILE"] as const;
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

function client(): DeepSeekClient {
  return new DeepSeekClient({
    baseUrl: "https://chat.deepseek.com",
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
}

function request(model: string, reasoning?: boolean, search = false): CanonicalRequest {
  return {
    model,
    stream: false,
    system: "",
    messages: [{ role: "user", parts: [{ type: "text", text: "Reply OK." }] }],
    tools: [],
    reasoning,
    search,
  };
}

function state(): UpstreamSessionState {
  return { chatSessionId: "test-session", parentMessageId: null, history: [], updatedAt: 0 };
}

async function capturePayload(model: string, reasoning?: boolean, search = false): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown> | null = null;
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v0/chat/create_pow_challenge")) {
      return new Response(JSON.stringify({
        code: 0,
        data: {
          biz_code: 0,
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
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"OK"}],"status":"FINISHED"}}}\n\n',
        { status: 200 },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof globalThis.fetch;

  await client().complete(request(model, reasoning, search), state());
  if (!payload) throw new Error("Completion payload was not captured");
  return payload;
}

describe("DeepSeek V4 model registry", () => {
  it("lists only V4 primary models", () => {
    expect(bridgeModelList().map(model => model.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
  });

  it.each([
    ["deepseek-v4-flash", "default", false],
    ["deepseek-v4-pro", "expert", false],
  ] as const)("maps %s to the observed Web mode", (model, upstreamModelType, thinkingEnabled) => {
    expect(resolveModelSelection(model)).toMatchObject({ upstreamModelType, thinkingEnabled });
  });

  it("keeps legacy aliases accepted but maps them to V4 Flash", () => {
    expect(resolveModelSelection("deepseek-chat")).toMatchObject({
      canonicalId: "deepseek-v4-flash",
      thinkingEnabled: false,
      legacyAlias: true,
    });
    expect(resolveModelSelection("deepseek-reasoner")).toMatchObject({
      canonicalId: "deepseek-v4-flash",
      thinkingEnabled: true,
      legacyAlias: true,
    });
  });

  it("builds the OpenCode provider/model id", () => {
    expect(openCodeModelId("deepseek-v4-pro")).toBe("deepseek-bridge/deepseek-v4-pro");
  });

  it("rejects an unknown model", () => {
    expect(() => resolveModelSelection("deepseek-v5-imaginary")).toThrow(/Unknown model/);
    try {
      resolveModelSelection("deepseek-v5-imaginary");
    } catch (error) {
      expect(error).toMatchObject({ code: "MODEL_UNAVAILABLE", status: 400 });
    }
  });

  it("rejects Search for Expert because the current Web UI does not expose it", () => {
    expect(() => resolveModelSelection("deepseek-v4-pro", false, true)).toThrow(/Search is not available/);
  });
});

describe("current DeepSeek Web completion payload", () => {
  it.each([
    ["deepseek-v4-flash", false, "default"],
    ["deepseek-v4-flash", true, "default"],
    ["deepseek-v4-pro", false, "expert"],
    ["deepseek-v4-pro", true, "expert"],
  ] as const)("sends %s with thinking=%s", async (model, thinking, modelType) => {
    const payload = await capturePayload(model, thinking);
    expect(payload).toMatchObject({
      model_type: modelType,
      thinking_enabled: thinking,
      search_enabled: false,
      action: null,
      preempt: false,
    });
    expect(payload).not.toHaveProperty("model_name");
    expect(payload).not.toHaveProperty("messages");
    expect(payload).not.toHaveProperty("additional_input");
  });

  it("passes Search independently for Instant", async () => {
    const payload = await capturePayload("deepseek-v4-flash", false, true);
    expect(payload).toMatchObject({ model_type: "default", thinking_enabled: false, search_enabled: true });
  });

  it("keeps legacy reasoner as a thinking-enabled Flash alias", async () => {
    const payload = await capturePayload("deepseek-reasoner");
    expect(payload).toMatchObject({ model_type: "default", thinking_enabled: true });
  });
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

describe("GET /v1/models", () => {
  it("returns V4 Flash and Pro without legacy aliases", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "bridge-models-"));
    const port = await freePort();
    let app: AppHandle | null = null;
    process.env.HOST = "127.0.0.1";
    process.env.PORT = String(port);
    process.env.DS_DATA_DIR = dataDir;
    process.env.DS_AUTH_FILE = join(dataDir, "auth.json");
    process.env.DS_SESSIONS_FILE = join(dataDir, "sessions.json");
    try {
      app = buildApp();
      await app.server.start();
      const response = await originalFetch(`http://127.0.0.1:${port}/v1/models`);
      expect(response.status).toBe(200);
      const body = await response.json() as { data: Array<{ id: string }> };
      expect(body.data.map(model => model.id)).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
      expect(body.data.map(model => model.id)).not.toContain("deepseek-chat");
      expect(body.data.map(model => model.id)).not.toContain("deepseek-reasoner");

      const unknown = await originalFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "deepseek-v5-imaginary",
          stream: false,
          messages: [{ role: "user", content: "Hello" }],
        }),
      });
      expect(unknown.status).toBe(400);
      await expect(unknown.json()).resolves.toMatchObject({
        error: { type: "MODEL_UNAVAILABLE", message: expect.stringContaining("Unknown model") },
      });
    } finally {
      await app?.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
