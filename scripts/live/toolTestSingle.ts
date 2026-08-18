import { spawn } from "child_process";
import { buildConfig } from "../../src/config/env.js";

const config = buildConfig();
const BASE = `http://${config.host}:${config.port}`;

function apiKeyHeaders(): Record<string, string> {
  return config.proxyApiKey ? { "x-api-key": config.proxyApiKey } : {};
}

async function waitForReady(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/readyz`);
      if (res.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Server not ready at ${BASE}`);
}

const ANTHROPIC_TOOLS = [
  {
    name: "get_weather",
    description: "Get the current weather for a location",
    input_schema: {
      type: "object",
      properties: {
        location: { type: "string", description: "City name" },
      },
      required: ["location"],
    },
  },
  {
    name: "calculate",
    description: "Perform a mathematical calculation",
    input_schema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Math expression like 2+2" },
      },
      required: ["expression"],
    },
  },
];

const OPENAI_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "get_weather",
      description: "Get the current weather for a location",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City name" },
        },
        required: ["location"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "calculate",
      description: "Perform a mathematical calculation",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "Math expression like 2+2" },
        },
        required: ["expression"],
      },
    },
  },
];

function isServerRunning(): Promise<boolean> {
  return fetch(`${BASE}/readyz`).then(r => r.ok).catch(() => false);
}

async function testAnthropicToolCall(model: string, thinking = false): Promise<void> {
  const label = `${model}${thinking ? "+thinking" : ""}`;
  console.log(`\n--- Anthropic: ${label} ---`);
  const body: Record<string, unknown> = {
    model,
    max_tokens: 1024,
    system: "You are a helpful assistant with tool access. ALWAYS use tools when the user asks for something that matches a tool.",
    messages: [
      { role: "user", content: "What is the weather in Moscow? You MUST use the get_weather tool." },
    ],
    tools: ANTHROPIC_TOOLS,
  };
  if (thinking) {
    body.thinking = { type: "enabled", budget_tokens: 512 };
    body.max_tokens = 2048;
  }

  const res = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...apiKeyHeaders() },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  console.log(`  HTTP ${res.status}`);

  if (res.status !== 200) { console.log(`  FAIL: ${JSON.stringify(json).slice(0, 300)}`); return; }

  const content = (json as any).content ?? [];
  const toolBlocks = content.filter((b: any) => b.type === "tool_use");
  const textBlocks = content.filter((b: any) => b.type === "text");
  const thinkingBlocks = content.filter((b: any) => b.type === "thinking");

  if (toolBlocks.length > 0) {
    console.log(`  [OK] Tool call: ${toolBlocks[0].name}(${JSON.stringify(toolBlocks[0].input).slice(0, 120)})`);
  } else {
    console.log(`  [FAIL] No tool_use block`);
    if (textBlocks.length > 0) console.log(`  Text: ${String(textBlocks[0]?.text ?? "").slice(0, 300)}`);
    if (thinkingBlocks.length > 0) console.log(`  Thinking: ${String(thinkingBlocks[0]?.thinking ?? "").slice(0, 200)}`);
  }
}

async function testOpenAIToolCall(model: string): Promise<void> {
  console.log(`\n--- OpenAI: ${model} ---`);
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...apiKeyHeaders() },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: "system", content: "You are a helpful assistant with tool access. ALWAYS use tools when asked." },
        { role: "user", content: "What is the weather in Moscow? You MUST use the get_weather tool." },
      ],
      tools: OPENAI_TOOLS,
    }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  console.log(`  HTTP ${res.status}`);

  if (res.status !== 200) { console.log(`  FAIL: ${JSON.stringify(json).slice(0, 300)}`); return; }

  const choice = (json as any).choices?.[0];
  const toolCalls = choice?.message?.tool_calls;
  const content = choice?.message?.content;

  if (toolCalls && toolCalls.length > 0) {
    console.log(`  [OK] Tool call: ${toolCalls[0].function?.name}(${toolCalls[0].function?.arguments})`);
  } else {
    console.log(`  [FAIL] No tool call`);
    console.log(`  Content: ${String(content ?? "").slice(0, 300)}`);
  }
}

async function main(): Promise<void> {
  const alreadyRunning = await isServerRunning();
  let serverProc: ReturnType<typeof spawn> | null = null;

  if (!alreadyRunning) {
    console.log("Starting server...");
    serverProc = spawn("node", ["node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
      cwd: "D:\\Проекты\\test router deepseek",
      stdio: "pipe",
      detached: true,
    });
    serverProc.unref();
    serverProc.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
    serverProc.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
    await waitForReady();
  }

  console.log(`Server ready at ${BASE}`);

  await testOpenAIToolCall("deepseek-chat");
  await testAnthropicToolCall("deepseek-chat");
  await testOpenAIToolCall("deepseek-reasoner");
  await testAnthropicToolCall("deepseek-reasoner");
  await testAnthropicToolCall("deepseek-reasoner", true);

  if (serverProc) {
    serverProc.kill();
    console.log("\nServer stopped.");
  }
  console.log("\n=== DONE ===");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
