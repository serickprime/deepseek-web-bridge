import { BridgeError } from "../utils/errors.js";
import { isRecord } from "../utils/json.js";
import type { CanonicalToolCall } from "../api/canonical.js";

const MAX_TOOL_BYTES = 48 * 1024;
const MAX_TOOL_CALL_DEPTH = 32;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const TOOL_NAME_RE = /^[A-Za-z_][\w.-]{0,127}$/;

export interface ToolParseResult {
  text: string;
  toolCall: CanonicalToolCall | null;
}

function isForbiddenKey(key: string): boolean {
  return DANGEROUS_KEYS.has(key);
}

function isPlainObject(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function makeId(): string {
  return `call_${Math.random().toString(36).slice(2, 10)}`;
}

function inspectNestedValues(value: unknown, depth = 0): string | null {
  if (depth > MAX_TOOL_CALL_DEPTH) return "excessive_nesting";
  if (!value || typeof value !== "object") return null;
  if (!isPlainObject(value)) return "unsafe_arguments";
  if (Array.isArray(value)) {
    for (const item of value) {
      const r = inspectNestedValues(item, depth + 1);
      if (r) return r;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) return "unsafe_arguments";
  }
  for (const item of Object.values(value)) {
    const r = inspectNestedValues(item, depth + 1);
    if (r) return r;
  }
  return null;
}

// --- Text extraction for model output that wraps JSON in prose ---

function extractToolCallFromText(text: string, allowedNames: string[]): { toolCall: CanonicalToolCall | null; reason: string } {
  const toolCallIdx = text.indexOf('"tool_call"');
  const nameIdx = text.indexOf('"name"');
  const searchIdx = toolCallIdx >= 0 ? toolCallIdx : nameIdx;
  if (searchIdx < 0) return { toolCall: null, reason: "no_tool_call_in_text" };

  // Scan backward for opening brace of the envelope
  let braceStart = -1;
  for (let i = searchIdx; i >= 0; i--) {
    if (text[i] === "{") { braceStart = i; break; }
  }

  // If no backward brace, scan forward after "tool_call": or "name":
  if (braceStart < 0) {
    const colonIdx = text.indexOf(":", searchIdx + 1);
    if (colonIdx >= 0 && colonIdx - searchIdx < 20) {
      for (let i = colonIdx + 1; i < text.length && i < colonIdx + 200; i++) {
        if (text[i] === "{") { braceStart = i; break; }
        if (text[i] === '"') break; // hit a string value, no brace
      }
    }
  }

  // Final fallback: scan forward from searchIdx for ANY opening brace
  if (braceStart < 0) {
    for (let i = searchIdx; i < text.length && i < searchIdx + 500; i++) {
      if (text[i] === "{") { braceStart = i; break; }
    }
  }

  if (braceStart < 0) return { toolCall: null, reason: "no_envelope_brace" };

  let depth = 0;
  let inString = false;
  let escape = false;
  let braceEnd = -1;
  for (let i = braceStart; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) { braceEnd = i; break; }
    }
  }
  if (braceEnd < 0) return { toolCall: null, reason: "unbalanced_braces" };

  const candidate = text.slice(braceStart, braceEnd + 1);
  let envelope: unknown;
  try {
    envelope = JSON.parse(candidate);
  } catch {
    return { toolCall: null, reason: "extracted_json_invalid" };
  }

  if (!isPlainObject(envelope)) return { toolCall: null, reason: "extracted_not_object" };
  const env = envelope as Record<string, unknown>;

  let toolValue: unknown;
  if ("tool_call" in env) {
    toolValue = env.tool_call;
  } else if ("name" in env && "arguments" in env) {
    toolValue = env;
  } else {
    return { toolCall: null, reason: "extracted_wrong_shape" };
  }

  return validateToolValue(toolValue, allowedNames);
}

function validateToolValue(value: unknown, allowedNames: string[]): { toolCall: CanonicalToolCall | null; reason: string } {
  if (!isPlainObject(value)) return { toolCall: null, reason: "invalid_tool_shape" };

  const v = value as Record<string, unknown>;
  // Require at least name + arguments, allow extra keys
  if (!("name" in v) || !("arguments" in v)) {
    return { toolCall: null, reason: "invalid_tool_shape" };
  }
  if (typeof v.name !== "string" || !TOOL_NAME_RE.test(v.name)) {
    return { toolCall: null, reason: "invalid_tool_name" };
  }
  if (!allowedNames.includes(v.name)) {
    return { toolCall: null, reason: "tool_not_allowed" };
  }
  if (!isPlainObject(v.arguments)) {
    return { toolCall: null, reason: "arguments_not_object" };
  }

  const nestedReason = inspectNestedValues(v.arguments);
  if (nestedReason) return { toolCall: null, reason: nestedReason };

  let argumentsJson: string;
  try {
    argumentsJson = JSON.stringify(v.arguments);
  } catch {
    return { toolCall: null, reason: "unsafe_arguments" };
  }

  return {
    toolCall: { id: makeId(), type: "function", name: v.name, arguments: v.arguments as Record<string, unknown> },
    reason: "accepted",
  };
}

function inspectToolCall(text: string, allowedNames: string[]): { toolCall: CanonicalToolCall | null; reason: string } {
  if (typeof text !== "string") return { toolCall: null, reason: "input_not_string" };
  if (Buffer.byteLength(text, "utf8") > MAX_TOOL_BYTES) return { toolCall: null, reason: "input_too_large" };
  const trimmed = text.trim();
  if (!trimmed) return { toolCall: null, reason: "empty_input" };

  // Try <tool_call> wrapper first
  const tagMatch = trimmed.match(/^<tool_call>\s*([\s\S]*?)\s*<\/tool_call>$/i);
  let envelope: unknown;
  try {
    envelope = JSON.parse(tagMatch ? tagMatch[1]! : trimmed);
  } catch {
    // Model may prepend prose before JSON. Try to extract tool_call JSON from text.
    return extractToolCallFromText(trimmed, allowedNames);
  }

  if (!isPlainObject(envelope)) return { toolCall: null, reason: "invalid_envelope" };

  const value = tagMatch ? envelope : (envelope as Record<string, unknown>).tool_call;
  if (!tagMatch && !Object.prototype.hasOwnProperty.call(envelope, "tool_call")) {
    return { toolCall: null, reason: "unexpected_envelope_keys" };
  }
  if (!tagMatch && Object.keys(envelope as Record<string, unknown>).length !== 1) {
    return { toolCall: null, reason: "unexpected_envelope_keys" };
  }
  if (!isPlainObject(value)) return { toolCall: null, reason: "invalid_tool_shape" };

  return validateToolValue(value, allowedNames);
}

export function inspectToolCallFromOutput(output: { content?: string; reasoning?: string }, allowedNames: string[]): { toolCall: CanonicalToolCall | null; reason: string; source: string } {
  if (!output || typeof output.content !== "string") {
    return { toolCall: null, reason: "invalid_output", source: "none" };
  }
  if (output.content.trim()) {
    const result = inspectToolCall(output.content, allowedNames);
    if (result.toolCall) return { ...result, source: "content" };
  }
  if (typeof output.reasoning === "string" && output.reasoning.trim()) {
    const result = inspectToolCall(output.reasoning, allowedNames);
    if (result.toolCall) return { ...result, source: "reasoning" };
  }
  return { toolCall: null, reason: "no_tool_call_found", source: "none" };
}

// --- Retry detection helpers ---

const INTENT_MAX_LENGTH = 300;

const INTENT_PATTERNS_RU = [
  /^я попробую/i,
  /^я выполню/i,
  /^я прочитаю/i,
  /^я запущу/i,
  /^я создам/i,
  /^я проверю/i,
  /^я открою/i,
  /^давайте я/i,
  /^давай я/i,
  /^сейчас я/i,
];

const INTENT_PATTERNS_EN = [
  /^let me /i,
  /^i will /i,
  /^i'll /i,
  /^i can run/i,
  /^i can read/i,
  /^i can create/i,
  /^i can check/i,
  /^i can open/i,
];

export function looksLikeToolIntentText(content: string, allowedToolNames: string[]): boolean {
  if (allowedToolNames.length === 0) return false;
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.length > INTENT_MAX_LENGTH) return false;

  const lower = trimmed.toLowerCase();

  const hasIntentPrefix =
    INTENT_PATTERNS_RU.some(p => p.test(trimmed)) ||
    INTENT_PATTERNS_EN.some(p => p.test(trimmed));

  if (!hasIntentPrefix) return false;

  for (const name of allowedToolNames) {
    if (lower.includes(name.toLowerCase())) return true;
  }

  const ACTION_OBJECT_RE = /файл|команд|директор|каталог|блок|строк|процесс|command|file|directory|folder|block|line|process|code|script/i;
  return ACTION_OBJECT_RE.test(trimmed);
}

// --- Fake tool trace detection ---
// When tools are available, the model sometimes outputs text like
// "Read file: D:\foo\bar.txt" instead of returning a real tool_call JSON.
// This is NOT a valid final answer — it's a pseudo-tool trace that must
// trigger a retry to force the model to emit actual tool_call JSON.

const FAKE_TRACE_MAX_LENGTH = 2000;

const FAKE_TRACE_PATTERNS: RegExp[] = [
  /^read file:\s*\S/im,
  /^write file:\s*\S/im,
  /^edit file:\s*\S/im,
  /^create file:\s*\S/im,
  /^delete file:\s*\S/im,
  /^move\/rename file:\s*\S/im,
  /^rename file:\s*\S/im,
  /^run command:\s*\S/im,
  /^bash:\s*\S/im,
  /^exec(?:ute)?:\s*\S/im,
  /^command:\s*\S/im,
  /^open file:\s*\S/im,
  /^check file:\s*\S/im,
  /^verify file:\s*\S/im,
  /^list directory:\s*\S/im,
  /^ls\s+\S/im,
  /^cat\s+\S/im,
  /^mkdir\s+\S/im,
  /^echo\s+\S/im,
];

export function looksLikeFakeToolTrace(content: string, allowedToolNames: string[]): boolean {
  if (allowedToolNames.length === 0) return false;
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.length > FAKE_TRACE_MAX_LENGTH) return false;

  const hasTools = allowedToolNames.some(n => {
    const lower = n.toLowerCase();
    return lower === "read" || lower === "write" || lower === "bash"
      || lower === "edit" || lower === "grep" || lower === "glob"
      || lower === "ls" || lower === "cat" || lower === "mkdir";
  });
  if (!hasTools) return false;

  const lines = trimmed.split("\n");
  let matchCount = 0;
  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;
    if (FAKE_TRACE_PATTERNS.some(p => p.test(l))) matchCount++;
  }

  if (matchCount >= 2) return true;

  if (lines.length === 1) {
    return FAKE_TRACE_PATTERNS.some(p => p.test(lines[0]!.trim()));
  }

  return false;
}

// --- Final answer verification ---
// After the model claims completion, we verify whether all user-requested
// actions were actually executed via real tool_use/tool_result pairs.

export interface PendingAction {
  description: string;
  fulfilled: boolean;
}

export interface FinalVerificationResult {
  complete: boolean;
  pendingActions: string[];
}

export function verifyFinalAnswer(
  pendingActions: PendingAction[],
): FinalVerificationResult {
  const unfulfilled = pendingActions.filter(a => !a.fulfilled).map(a => a.description);
  return { complete: unfulfilled.length === 0, pendingActions: unfulfilled };
}

export const COMPLETION_GUARD_MAX_ATTEMPTS = 3;

function shouldRetryToolResponse(hasTools: boolean, output: { content?: string; reasoning?: string }, toolCall: CanonicalToolCall | null): boolean {
  return !toolCall && hasTools
    && typeof output.content === "string" && output.content.trim() === ""
    && typeof output.reasoning === "string" && output.reasoning.trim() !== "";
}

function shouldRetryFencedToolResponse(hasTools: boolean, toolCall: CanonicalToolCall | null, inspection: { reason: string; source: string }): boolean {
  return !toolCall && hasTools
    && inspection.source === "content"
    && inspection.reason === "invalid_json";
}

export function createToolRetryPrompt(allowedNames: string[]): string {
  return [
    "Your previous response contained text instead of a tool call.",
    "Output ONLY the JSON envelope below — nothing else:",
    '{"tool_call":{"name":"TOOL_NAME","arguments":{}}}',
    `Allowed tool names: ${JSON.stringify(allowedNames)}`,
    "No reasoning. No explanations. No Markdown. No text before or after.",
    "If no tool is needed, output only your final text answer.",
  ].join("\n");
}

// --- Historical tool invocation text for upstream ---

export function historicalToolInvocationText(name: string, callId: string, argumentsValue: unknown): string {
  let serializedArguments: string;
  if (typeof argumentsValue === "string") {
    try { serializedArguments = JSON.stringify(JSON.parse(argumentsValue)); } catch { serializedArguments = JSON.stringify(argumentsValue); }
  } else {
    serializedArguments = JSON.stringify(argumentsValue ?? {});
  }
  return `[Historical Action Record: already requested by the assistant]\ntool_name_data: ${JSON.stringify(String(name || "unknown"))}\ncorrelation_id_data: ${JSON.stringify(String(callId || "unknown"))}\narguments_data: ${serializedArguments}\n[End Historical Action Record]`;
}

export function toolResultText(name: string, callId: string, result: unknown): string {
  const content = typeof result === "string" ? result : JSON.stringify(result ?? {});
  return `[Tool Result]\nname: ${name || "unknown"}\ncall_id: ${callId || "unknown"}\nresult:\n${content}`;
}

// --- OpenAI message text builder (reference from FreeDeepseekAPI) ---

function sessionToolName(session: { toolCalls?: Map<string, { name: string }> | null } | null, callId: string): string {
  if (!callId || !(session?.toolCalls instanceof Map)) return "";
  const stored = session.toolCalls.get(callId);
  return typeof stored === "string" ? stored : stored?.name || "";
}

function openAIMessageText(message: Record<string, unknown>, session: { toolCalls?: Map<string, { name: string }> | null } | null): string {
  const role = String(message.role || "user");
  if (role === "tool") {
    const callId = String(message.tool_call_id || "");
    return `tool: ${toolResultText(String(message.name || sessionToolName(session, callId)), callId, message.content)}`;
  }
  const parts: string[] = [];
  const content = typeof message.content === "string" ? message.content : Array.isArray(message.content)
    ? message.content.map((item: unknown) => typeof item === "string" ? item : (item as Record<string, unknown>)?.text || "").join("\n") : "";
  if (content) parts.push(`${role}: ${content}`);
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const callId = (call as Record<string, unknown>)?.id || "";
      const fn = (call as Record<string, unknown>)?.function as Record<string, unknown> | undefined;
      parts.push(`${role}: ${historicalToolInvocationText(String(fn?.name || sessionToolName(session, String(callId))), String(callId), fn?.arguments)}`);
    }
  }
  return parts.join("\n");
}

function anthropicMessageText(message: Record<string, unknown>, session: { toolCalls?: Map<string, { name: string }> | null } | null): string {
  if (!Array.isArray(message.content)) return typeof message.content === "string" ? message.content : "";
  return message.content.map((block: unknown) => {
    if (!block || typeof block !== "object") return "";
    const b = block as Record<string, unknown>;
    if (b.type === "text" || b.type === "thinking") return String(b.text || b.thinking || "");
    if (b.type === "tool_use") return historicalToolInvocationText(String(b.name || ""), String(b.id || ""), b.input);
    if (b.type === "tool_result") {
      const callId = String(b.tool_use_id || "");
      return toolResultText(sessionToolName(session, callId), callId, b.content);
    }
    return "";
  }).filter(Boolean).join("\n");
}

export function buildUpstreamPrompt(body: Record<string, unknown>, kind: string, session: { toolCalls?: Map<string, { name: string }> | null } | null): string {
  if (kind === "anthropic") {
    const systemText = body.system ? `System: ${typeof body.system === "string" ? body.system : JSON.stringify(body.system)}` : "";
    const msgs = Array.isArray(body.messages) ? body.messages.map((m: unknown) => `${(m as Record<string, unknown>).role}: ${anthropicMessageText(m as Record<string, unknown>, session)}`) : [];
    return [systemText, ...msgs].filter(Boolean).join("\n");
  }
  if (kind === "responses") {
    const input = (body as Record<string, unknown>).input;
    if (typeof input === "string") return input;
    if (!Array.isArray(input)) return "";
    return input.map((item: unknown) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      const i = item as Record<string, unknown>;
      if (i.type === "function_call") return historicalToolInvocationText(String(i.name || ""), String(i.call_id || i.id || ""), i.arguments);
      if (i.type === "function_call_output") return toolResultText(String(i.name || ""), String(i.call_id || ""), i.output);
      if (i.type === "message") return `${i.role || "user"}: ${typeof i.content === "string" ? i.content : JSON.stringify(i.content)}`;
      return "";
    }).filter(Boolean).join("\n");
  }
  // openai
  if (!Array.isArray(body.messages)) return "";
  return body.messages.map((m: unknown) => openAIMessageText(m as Record<string, unknown>, session)).filter(Boolean).join("\n");
}

export function parseToolInvocation(text: string, toolNames?: Set<string>): ToolParseResult {
  const allowedNames = toolNames ? [...toolNames] : [];
  const { toolCall, reason } = inspectToolCall(text, allowedNames);
  if (toolCall) return { text: "", toolCall };

  if (toolNames && toolNames.size > 0) {
    const tagOpen = text.indexOf("<tool_call>");
    if (tagOpen >= 0) {
      throw new BridgeError("Malformed tool invocation.", { code: "TOOL_PARSE_FAILED" });
    }
  }

  return { text: text.trim(), toolCall: null };
}

export function hasToolTag(text: string): boolean {
  return text.includes("<tool_call>") || text.includes('{"tool_call":');
}
