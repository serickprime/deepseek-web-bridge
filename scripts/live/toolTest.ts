import { buildConfig } from "../../src/config/env.js";

const config = buildConfig();
const BASE = `http://${config.host}:${config.port}`;

function apiKeyHeaders(): Record<string, string> {
  return config.proxyApiKey ? { "x-api-key": config.proxyApiKey } : {};
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function waitForReady(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/readyz`);
      if (res.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`Server not ready at ${BASE}`);
}

const TEST_TOOLS = [
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

async function testOpenAIToolCall(model: string, label: string): Promise<void> {
  console.log(`\n--- OpenAI tool call: ${label} (${model}) ---`);
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...apiKeyHeaders() },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: "user", content: "What is the weather in Moscow? Use the get_weather tool." },
      ],
      tools: TEST_TOOLS,
    }),
  });
  console.log(`  HTTP ${res.status}`);
  const json = (await res.json()) as Record<string, unknown>;
  console.log(`  Response: ${JSON.stringify(json).slice(0, 500)}`);

  if (res.status !== 200) {
    console.log(`  [FAIL] HTTP ${res.status}`);
    return;
  }

  const choice = (json as any).choices?.[0];
  const message = choice?.message;
  const toolCalls = message?.tool_calls;

  if (toolCalls && toolCalls.length > 0) {
    console.log(`  [OK] Tool call received: ${toolCalls[0].function?.name}(${toolCalls[0].function?.arguments})`);
    console.log(`  finish_reason: ${choice?.finish_reason}`);
  } else {
    console.log(`  [WARN] No tool call. Content: ${String(message?.content ?? "").slice(0, 200)}`);
    console.log(`  finish_reason: ${choice?.finish_reason}`);
  }
}

async function testOpenAIStreamToolCall(model: string, label: string): Promise<void> {
  console.log(`\n--- OpenAI STREAM tool call: ${label} (${model}) ---`);
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...apiKeyHeaders() },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        { role: "user", content: "What is the weather in Moscow? Use the get_weather tool." },
      ],
      tools: TEST_TOOLS,
    }),
  });
  console.log(`  HTTP ${res.status}, content-type: ${res.headers.get("content-type")}`);

  if (res.status !== 200) {
    const body = await res.text();
    console.log(`  [FAIL] ${body.slice(0, 300)}`);
    return;
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let toolCallFound = false;
  let contentText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta;
        if (delta?.content) contentText += delta.content;
        if (delta?.tool_calls) {
          toolCallFound = true;
          for (const tc of delta.tool_calls) {
            console.log(`  Tool call delta: id=${tc.id} name=${tc.function?.name} args=${tc.function?.arguments}`);
          }
        }
        const finish = parsed.choices?.[0]?.finish_reason;
        if (finish) console.log(`  finish_reason: ${finish}`);
      } catch {}
    }
  }

  if (toolCallFound) {
    console.log(`  [OK] Tool call received in stream`);
  } else {
    console.log(`  [WARN] No tool call in stream. Content: ${contentText.slice(0, 200)}`);
  }
}

async function testAnthropicToolCall(model: string, label: string, thinking = false): Promise<void> {
  console.log(`\n--- Anthropic tool call: ${label} (${model}, thinking=${thinking}) ---`);
  const body: Record<string, unknown> = {
    model,
    max_tokens: 1024,
    system: "You are a helpful assistant. Always use tools when asked.",
    messages: [
      { role: "user", content: "What is the weather in Moscow? Use the get_weather tool." },
    ],
    tools: ANTHROPIC_TOOLS,
  };
  if (thinking) {
    body.thinking = { type: "enabled", budget_tokens: 512 };
    body.max_tokens = 2048;
  }

  const res = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...apiKeyHeaders(),
    },
    body: JSON.stringify(body),
  });
  console.log(`  HTTP ${res.status}`);
  const json = (await res.json()) as Record<string, unknown>;
  console.log(`  Response: ${JSON.stringify(json).slice(0, 600)}`);

  if (res.status !== 200) {
    console.log(`  [FAIL] HTTP ${res.status}`);
    return;
  }

  const content = (json as any).content ?? [];
  const textBlocks = content.filter((b: any) => b.type === "text");
  const toolBlocks = content.filter((b: any) => b.type === "tool_use");
  const thinkingBlocks = content.filter((b: any) => b.type === "thinking");

  console.log(`  stop_reason: ${(json as any).stop_reason}`);
  console.log(`  blocks: ${content.length} (text=${textBlocks.length}, tool_use=${toolBlocks.length}, thinking=${thinkingBlocks.length})`);

  if (thinkingBlocks.length > 0) {
    console.log(`  Thinking: ${String(thinkingBlocks[0]?.thinking ?? "").slice(0, 100)}`);
  }
  if (textBlocks.length > 0) {
    console.log(`  Text: ${String(textBlocks[0]?.text ?? "").slice(0, 200)}`);
  }
  if (toolBlocks.length > 0) {
    console.log(`  [OK] Tool call: ${toolBlocks[0].name}(${JSON.stringify(toolBlocks[0].input).slice(0, 100)})`);
    console.log(`  Tool call id: ${toolBlocks[0].id}`);
  } else {
    console.log(`  [WARN] No tool_use block`);
  }
}

async function testAnthropicStreamToolCall(model: string, label: string, thinking = false): Promise<void> {
  console.log(`\n--- Anthropic STREAM tool call: ${label} (${model}, thinking=${thinking}) ---`);
  const body: Record<string, unknown> = {
    model,
    max_tokens: 1024,
    stream: true,
    system: "You are a helpful assistant. Always use tools when asked.",
    messages: [
      { role: "user", content: "What is the weather in Moscow? Use the get_weather tool." },
    ],
    tools: ANTHROPIC_TOOLS,
  };
  if (thinking) {
    body.thinking = { type: "enabled", budget_tokens: 512 };
    body.max_tokens = 2048;
  }

  const res = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...apiKeyHeaders(),
    },
    body: JSON.stringify(body),
  });
  console.log(`  HTTP ${res.status}, content-type: ${res.headers.get("content-type")}`);

  if (res.status !== 200) {
    const errBody = await res.text();
    console.log(`  [FAIL] ${errBody.slice(0, 300)}`);
    return;
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let events: string[] = [];
  let toolBlockStart = false;
  let contentBlockStarts = 0;
  let contentDeltas = 0;
  let toolDeltas = 0;
  let thinkingDeltas = 0;
  let errors: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (!part.trim()) continue;
      events.push(part);
      const lines = part.split("\n");
      let eventType = "";
      let dataStr = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) eventType = line.slice(7);
        if (line.startsWith("data: ")) dataStr = line.slice(6);
      }
      if (!dataStr) continue;
      try {
        const data = JSON.parse(dataStr);
        if (eventType === "content_block_start") {
          contentBlockStarts++;
          console.log(`  [event] content_block_start: type=${data.content_block?.type} index=${data.index}`);
          if (data.content_block?.type === "tool_use") toolBlockStart = true;
        }
        if (eventType === "content_block_delta") {
          contentDeltas++;
          if (data.delta?.type === "input_json_delta") {
            toolDeltas++;
          } else if (data.delta?.type === "thinking_delta") {
            thinkingDeltas++;
          }
        }
        if (eventType === "content_block_stop") {
          console.log(`  [event] content_block_stop: index=${data.index}`);
        }
        if (eventType === "message_delta") {
          console.log(`  [event] message_delta: stop_reason=${data.delta?.stop_reason}`);
        }
        if (eventType === "message_stop") {
          console.log(`  [event] message_stop`);
        }
        if (eventType === "error") {
          errors.push(JSON.stringify(data));
        }
      } catch {}
    }
  }

  console.log(`  Summary: blocks=${contentBlockStarts} deltas=${contentDeltas} tool_deltas=${toolDeltas} thinking_deltas=${thinkingDeltas}`);
  console.log(`  Total SSE events: ${events.length}`);
  if (errors.length > 0) console.log(`  [ERRORS] ${errors.join("; ")}`);

  if (toolBlockStart && toolDeltas > 0) {
    console.log(`  [OK] Tool call streamed correctly`);
  } else if (toolBlockStart) {
    console.log(`  [WARN] Tool block started but no input_json_delta`);
  } else {
    console.log(`  [WARN] No tool_use block in stream`);
  }
}

async function main(): Promise<void> {
  await waitForReady();
  console.log(`Server ready at ${BASE}`);

  // === deepseek-chat (non-reasoning) ===
  await testOpenAIToolCall("deepseek-chat", "chat");
  await testOpenAIStreamToolCall("deepseek-chat", "chat");
  await testAnthropicToolCall("deepseek-chat", "chat");
  await testAnthropicStreamToolCall("deepseek-chat", "chat");

  // === deepseek-reasoner (reasoning) ===
  await testOpenAIToolCall("deepseek-reasoner", "reasoner");
  await testOpenAIStreamToolCall("deepseek-reasoner", "reasoner");
  await testAnthropicToolCall("deepseek-reasoner", "reasoner", true);
  await testAnthropicStreamToolCall("deepseek-reasoner", "reasoner", true);
  await testAnthropicToolCall("deepseek-reasoner", "reasoner", false);
  await testAnthropicStreamToolCall("deepseek-reasoner", "reasoner", false);

  console.log("\n=== ALL LIVE TESTS DONE ===");
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
