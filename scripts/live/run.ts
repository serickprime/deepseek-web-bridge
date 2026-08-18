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
    } catch {
      // server not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`Server not ready at ${BASE}`);
}

async function main(): Promise<void> {
  await waitForReady();
  console.log(`Server ready at ${BASE}`);

  const health = await fetch(`${BASE}/health`);
  assert(health.status === 200, "health returned non-200");
  console.log("[OK] /health");

  const models = await fetch(`${BASE}/v1/models`, { headers: apiKeyHeaders() });
  assert(models.status === 200, "models returned non-200");
  const modelsJson = (await models.json()) as { data?: unknown[] };
  const modelCount = modelsJson.data?.length ?? 0;
  assert(modelCount > 0, "models list empty");
  console.log(`[OK] /v1/models (${modelCount} models)`);
  const chat = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...apiKeyHeaders() },
    body: JSON.stringify({
      model: "deepseek-chat",
      stream: false,
      messages: [{ role: "user", content: "Reply with the single word: pong" }],
    }),
  });
  assert(chat.status === 200, `chat completions returned HTTP ${chat.status}`);
  const chatJson = (await chat.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = chatJson.choices?.[0]?.message?.content ?? "";
  assert(content.length > 0, "empty completion content");
  console.log(`[OK] /v1/chat/completions -> ${content.slice(0, 40)}`);

  const anthropic = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...apiKeyHeaders(),
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      max_tokens: 64,
      messages: [{ role: "user", content: "Reply with the single word: pong" }],
    }),
  });
  assert(anthropic.status === 200, `anthropic messages returned HTTP ${anthropic.status}`);
  const anthropicJson = (await anthropic.json()) as { content?: Array<{ text?: string }> };
  const anthropicText = anthropicJson.content?.[0]?.text ?? "";
  assert(anthropicText.length > 0, "empty anthropic content");
  console.log(`[OK] /v1/messages -> ${anthropicText.slice(0, 40)}`);

  console.log("");
  console.log("Live smoke test passed.");
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
