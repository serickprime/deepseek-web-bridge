import type { CanonicalTool } from "../api/canonical.js";

export function buildToolPrompt(tools: CanonicalTool[]): string {
  if (tools.length === 0) return "";

  const safe = tools.slice(0, 32).map(t => ({
    name: t.name,
    description: (t.description ?? "").slice(0, 1000),
    parameters: t.inputSchema ?? {},
  }));

  const toolList = safe.map(t => {
    const desc = t.description || "No description";
    const args = Object.keys((t.parameters as Record<string, unknown>)?.properties as Record<string, unknown> || {});
    return `- ${t.name}\n  Purpose: ${desc}\n  Arguments: ${args.join(", ") || "none"}`;
  }).join("\n");

  return [
    "",
    "--- TOOL REQUEST SYSTEM ---",
    "Available tools:",
    toolList,
    "",
    "First decide: does the task require one of the available tools?",
    "",
    "If NO tool is needed: return the normal final answer as plain text.",
    "Do not invent tool calls when the question can be answered directly.",
    "",
    "If a tool IS required: return exactly one JSON object and nothing else:",
    '{"tool_call":{"name":"tool_name","arguments":{}}}',
    "No Markdown. No explanations. No text before or after the JSON.",
    "Use only the tool names listed above.",
    "Prefer the most specific available tool for the task.",
    "Do not use a general shell/command tool when a dedicated available tool can perform the operation directly.",
    "Do not simulate or describe the tool result — wait for the real tool result.",
    "--- END TOOL REQUEST SYSTEM ---",
  ].join("\n");
}

export function buildToolNames(tools: CanonicalTool[]): Set<string> {
  return new Set(tools.map(tool => tool.name));
}
