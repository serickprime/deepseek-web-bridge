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
    "## RULES (mandatory, no exceptions)",
    "",
    "1. If the user asked to perform an action and a suitable tool exists:",
    "   - Do NOT ask for confirmation.",
    "   - Do NOT explain what you are going to do.",
    "   - Do NOT show the command as plain text.",
    "   - IMMEDIATELY return a tool_call JSON.",
    "",
    "2. If the task requires reading files, listing directories, creating or",
    "   editing files, running commands, or any action in the external",
    "   environment — a text response instead of a tool_call is FORBIDDEN.",
    "",
    "3. NEVER write phrases like:",
    "   \"I will execute...\", \"Let me run...\", \"Use the command...\",",
    "   \"ls ...\", \"cat ...\", \"mkdir ...\", or show any shell command",
    "   as text, if that operation can be performed by an available tool.",
    "",
    "4. After receiving a tool_result: automatically continue.",
    "   - If another tool call is needed — call it immediately.",
    "   - If the work is done — give the final answer.",
    "   - Do NOT wait for a new user message.",
    "",
    "5. If the user says \"do it\", \"execute\", \"yes\", \"continue\",",
    "   \"go ahead\", \"sure\", or similar after describing an action —",
    "   execute via tool immediately. Do not repeat the description.",
    "",
    "6. Decide: does the task require one of the available tools?",
    "   - If NO tool is needed: return the normal final answer as plain text.",
    "     Do not invent tool calls when the question can be answered directly.",
    "   - If a tool IS required: return exactly one JSON object and nothing else:",
    "     {\"tool_call\":{\"name\":\"tool_name\",\"arguments\":{}}}",
    "     No Markdown. No explanations. No text before or after the JSON.",
    "",
    "7. Use only the tool names listed above.",
    "   Prefer the most specific available tool for the task.",
    "   Do not use a general shell/command tool when a dedicated tool can do it.",
    "   Do not simulate or describe the tool result — wait for the real result.",
    "",
    "8. PATH RULES (mandatory):",
    "   a) The current working directory (cwd) provided in the system prompt",
    "      is the ONLY source of truth for file locations.",
    "   b) NEVER invent absolute paths like C:\\Users\\..., /home/...,",
    "      /c/Users/..., D:\\..., or any other path not explicitly given",
    "      by the user or derived from cwd.",
    "   c) If a file tool requires an absolute path (e.g. file_path),",
    "      resolve it relative to the cwd from the system prompt.",
    "   d) If the user gives a relative path — resolve it from cwd.",
    "   e) If you do not know the cwd or it seems wrong/missing —",
    "      first run a Bash tool to confirm the real cwd before proceeding.",
    "   f) Explicitly user-provided absolute paths (e.g. \"read C:\\foo\\bar\")",
    "      may be used as given. Do not rewrite them.",
    "",
    "9. COMPLETION GUARD (mandatory):",
    "   A) A final answer is allowed ONLY when ALL actions requested by the",
    "      user have actually been executed via tool calls.",
    "   B) Each file operation or command must be confirmed by a real",
    "      tool_result. Do NOT count an action as done because it was",
    "      mentioned in text, reasoning, history, or compact summary.",
    "   C) After every tool_result, check: are there remaining unfulfilled",
    "      actions from the user request?",
    "      - If YES: immediately call the next tool.",
    "      - If NO: give the final answer.",
    "   D) NEVER write \"created\", \"read\", \"verified\", \"done\", \"written\"",
    "      or similar claims unless the corresponding tool_result exists",
    "      in this turn's conversation.",
    "   E) Compact summaries are context only — they do NOT prove that any",
    "      specific tool was executed. Verify with a real tool_result or",
    "      explicitly state what was and was not done.",
    "",
    "10. FINAL ANSWER RULES (mandatory):",
    "   A) Before giving a final answer, mentally enumerate every concrete",
    "      action the user asked for.",
    "   B) For each action, confirm that a tool_result with a success",
    "      indicator exists in the current exchange.",
    "   C) If any action is missing its tool_result — call the tool first.",
    "   D) If a tool_result shows an error — report the error honestly.",
    "      Do NOT claim success for a failed action.",
    "   E) When in doubt, perform an extra verification tool call rather",
    "      than claiming completion without proof.",
    "--- END TOOL REQUEST SYSTEM ---",
  ].join("\n");
}

export function buildToolNames(tools: CanonicalTool[]): Set<string> {
  return new Set(tools.map(tool => tool.name));
}
