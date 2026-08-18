import type { CanonicalTool } from "../api/canonical.js";

export function buildToolPrompt(tools: CanonicalTool[]): string {
  if (tools.length === 0) return "";

  const safe = tools.slice(0, 32).map(t => ({
    name: t.name,
    description: (t.description ?? "").slice(0, 1000),
    parameters: t.inputSchema ?? {},
  }));

  return [
    "",
    "--- TOOL REQUEST SYSTEM ---",
    "CRITICAL: Your entire response must be EXACTLY one JSON object. Nothing else.",
    "No reasoning, no explanations, no planning, no Markdown, no text before or after.",
    "When a tool is needed, output ONLY this envelope:",
    '{"tool_call":{"name":"tool_name","arguments":{}}}',
    "If no tool is needed, output only the final text answer.",
    "Do not write \"I will use...\", \"Let me...\", \"We need to...\", or any other prose.",
    "Do not simulate or describe tool results.",
    "Wait for the real tool result in the next message.",
    "Do not claim data is unavailable before attempting the appropriate available tool.",
    `Use ONLY these tool names: ${safe.map(t => t.name).join(", ")}`,
    `Each tool's arguments: ${JSON.stringify(safe.map(t => ({ name: t.name, args: Object.keys((t.parameters as Record<string, unknown>)?.properties as Record<string, unknown> || {}) })))}`,
    "--- END TOOL REQUEST SYSTEM ---",
  ].join("\n");
}

export function buildToolNames(tools: CanonicalTool[]): Set<string> {
  return new Set(tools.map(tool => tool.name));
}
