import { BridgeError } from "../utils/errors.js";
import { isRecord } from "../utils/json.js";
import type { CanonicalMessage, CanonicalToolCall } from "../api/canonical.js";

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

export interface CurrentToolCycleEvidence {
  currentUserText: string;
  hasCurrentToolResult: boolean;
  hasSuccessfulCurrentToolResult: boolean;
  hasFailedCurrentToolResult: boolean;
  requiresEnvironmentToolResult: boolean;
  requiresActionToolResult: boolean;
  requiredActionKinds: ExternalActionKind[];
  fulfilledActionKinds: ExternalActionKind[];
  missingActionKinds: ExternalActionKind[];
  failedToolNames: string[];
  failedToolFingerprints: string[];
  hasUnavailableToolFailure: boolean;
}

export type ExternalActionKind = "file_mutation" | "command_execution" | "launch" | "dependency_install";

const INFORMATIONAL_PREFIXES = [
  "что такое ",
  "что означает ",
  "как работает ",
  "как использовать ",
  "как пользоваться ",
  "как ",
  "объясни ",
  "расскажи ",
  "зачем ",
  "для чего ",
  "what is ",
  "what does ",
  "how does ",
  "how do i use ",
  "how to ",
  "explain ",
  "describe ",
  "why ",
];

function hasToolMatching(allowedToolNames: string[], pattern: RegExp): boolean {
  return allowedToolNames.some(name => pattern.test(name.toLowerCase()));
}

export function looksLikeEnvironmentDataRequest(content: string, allowedToolNames: string[]): boolean {
  if (allowedToolNames.length === 0) return false;
  const trimmed = content.trim();
  if (!trimmed) return false;
  const normalized = trimmed.toLowerCase().replace(/\s+/g, " ");
  if (INFORMATIONAL_PREFIXES.some(prefix => normalized.startsWith(prefix))) return false;

  const hasShell = hasToolMatching(allowedToolNames, /bash|shell|powershell|terminal|command|exec/);
  const hasReader = hasToolMatching(allowedToolNames, /^(?:read|cat)$|read.?file/);
  const hasLister = hasToolMatching(allowedToolNames, /^(?:glob|grep|ls|find)$|list.?dir/);
  const action = /проверь|покажи|выведи|перечисли|посмотри|прочитай|открой|найди|узнай|выполни|запусти|check|show|list|inspect|read|open|find|verify|run|execute/i.test(trimmed);

  const currentCwd = /текущ\S*\s+(?:рабоч\S*\s+)?(?:директор|папк)|рабоч\S*\s+директор|\bcwd\b|current working directory|present working directory|where am i/i.test(trimmed);
  const explicitPwd = /(?:^|\n)\s*pwd\s*[.!?]*\s*$/im.test(trimmed) || (action && /\bpwd\b/i.test(trimmed));
  if (hasShell && (currentCwd || explicitPwd)) return true;

  const directoryListing = /содержим\S*\s+(?:текущ\S*\s+)?(?:рабоч\S*\s+)?(?:директор|папк)|список\S*\s+(?:файл|папок)|структур\S*\s+проект|какие\s+(?:файл|папк)\S*\s+здесь|что\s+в\s+(?:этой\s+)?папк|directory contents|contents of (?:the )?(?:current )?(?:directory|folder)|list (?:the )?(?:current )?(?:directory|folder|files)|what files are here|project structure/i.test(trimmed);
  const explicitListingCommand = /(?:^|\n)\s*(?:ls(?:\s+[^\r\n]+)?|get-childitem(?:\s+[^\r\n]+)?)\s*$/im.test(trimmed);
  if ((hasShell || hasLister) && (directoryListing || (action && explicitListingCommand))) return true;

  const fileContent = /содержим\S*|прочита\S*|покаж\S*\s+файл|file contents|contents of (?:the )?file|read (?:the )?(?:file\b|[^\r\n]{0,120}\.[a-z0-9_-]{1,16}\b)/i.test(trimmed);
  const fileExistence = /существу\S*\s+(?:ли\s+)?файл|наличи\S*\s+файл|does (?:the )?file\b.*\bexist|check (?:whether )?.*file exists|file existence/i.test(trimmed);
  if ((hasReader || hasLister || hasShell) && (fileExistence || (action && fileContent))) return true;

  const commandExecution = /выполни\S*(?:\s+команд\S*)?|запусти\S*(?:\s+команд\S*)?|run (?:the )?command|execute (?:the )?command/i.test(trimmed);
  return hasShell && commandExecution;
}

function inferExternalActionKinds(content: string, allowedToolNames: string[]): ExternalActionKind[] {
  if (allowedToolNames.length === 0) return [];
  const trimmed = content.trim();
  if (!trimmed) return [];
  const normalized = trimmed.toLowerCase().replace(/\s+/g, " ");
  if (INFORMATIONAL_PREFIXES.some(prefix => normalized.startsWith(prefix))) return [];

  const hasShell = hasToolMatching(allowedToolNames, /bash|shell|powershell|terminal|command|exec/);
  const hasFileWriter = hasToolMatching(allowedToolNames, /write|edit|create|delete|remove|rename|move|copy/)
    || hasShell;
  const hasLauncher = hasShell || hasToolMatching(allowedToolNames, /browser|open|launch/);
  const kinds = new Set<ExternalActionKind>();

  const externalTarget = /файл|папк|каталог|проект|лендинг|сайт|страниц|програм|скрипт|конфиг|документ|зависимост|пакет|\b[\w.-]+\.[a-z0-9_-]{1,16}\b|file|folder|directory|project|landing|website|site|page|program|script|config|document|dependency|package/i.test(trimmed);
  const fileMutation = /созда\S*|сделай|сохран\S*|запиш\S*|измен\S*|отредактир\S*|удал\S*|переимен\S*|перемест\S*|скопир\S*|create|make|build|save|write|modify|change|edit|delete|remove|rename|move|copy/i.test(trimmed);
  if (hasFileWriter && externalTarget && fileMutation) kinds.add("file_mutation");

  const install = /установ\S*|добав\S*\s+(?:зависимост|пакет)|install|add (?:the )?(?:dependency|package)/i.test(trimmed);
  if (hasShell && install) kinds.add("dependency_install");

  const commandExecution = /выполн\S*(?:\s+команд\S*)?|запуст\S*\s+команд\S*|run (?:the )?command|execute (?:the )?command/i.test(trimmed);
  const launch = !commandExecution
    && /запуст\S*|открой\S*|подними\S*(?:\s+(?:сайт|сервер|приложен))?|launch|start|open|serve/i.test(trimmed);
  if (hasLauncher && launch) kinds.add("launch");

  if (hasShell && commandExecution) kinds.add("command_execution");

  return [...kinds];
}

export function looksLikeExternalActionRequest(content: string, allowedToolNames: string[]): boolean {
  return inferExternalActionKinds(content, allowedToolNames).length > 0;
}

function toolArgumentText(toolCall: CanonicalToolCall): string {
  try {
    return JSON.stringify(toolCall.arguments);
  } catch {
    return "";
  }
}

function normalizeToolArgumentValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeToolArgumentValue);
  if (!value || typeof value !== "object") return value;

  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) normalized[key] = normalizeToolArgumentValue(item);
  }
  return normalized;
}

export function toolCallFingerprint(name: string, argumentsValue: Record<string, unknown>): string {
  const normalizedArguments = { ...argumentsValue };
  if (name.trim().toLowerCase() === "bash") delete normalizedArguments.description;
  return `${name.trim()}\n${JSON.stringify(normalizeToolArgumentValue(normalizedArguments))}`;
}

export function isRepeatedFailedToolCall(
  toolCall: unknown,
  evidence?: CurrentToolCycleEvidence,
): boolean {
  if (!evidence || !toolCall || typeof toolCall !== "object") return false;
  const candidate = toolCall as { name?: unknown; arguments?: unknown };
  if (typeof candidate.name !== "string" || !isPlainObject(candidate.arguments)) return false;
  return evidence.failedToolFingerprints.includes(toolCallFingerprint(
    candidate.name,
    candidate.arguments as Record<string, unknown>,
  ));
}

function fulfilledKindsForTool(toolCall: CanonicalToolCall): ExternalActionKind[] {
  const name = toolCall.name.toLowerCase();
  const args = toolArgumentText(toolCall);
  const kinds = new Set<ExternalActionKind>();
  const isShell = /bash|shell|powershell|terminal|command|exec/.test(name);

  if (/write|edit|create|delete|remove|rename|move|copy/.test(name)) {
    kinds.add("file_mutation");
  }
  if (/browser|open|launch/.test(name)) kinds.add("launch");
  if (/install|package/.test(name)) kinds.add("dependency_install");
  if (isShell) {
    kinds.add("command_execution");
    if (/>>?|\b(?:tee|touch|mkdir|rm|mv|cp|del|copy|move|remove-item|new-item|set-content|add-content|out-file)\b/i.test(args)) {
      kinds.add("file_mutation");
    }
    if (/\b(?:start|open|xdg-open|explorer|start-process|invoke-item)\b|\bpython(?:3)?\s+-m\s+http\.server\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:start|dev|preview)\b|\bnpx\s+(?:vite|serve|http-server)\b|\b(?:node|python|python3)\s+[^;\r\n]+/i.test(args)) {
      kinds.add("launch");
    }
    if (/\b(?:npm|pnpm|yarn|bun)\s+(?:install|add)\b|\bpip(?:3)?\s+install\b|\b(?:brew|apt(?:-get)?|dnf|yum)\s+install\b/i.test(args)) {
      kinds.add("dependency_install");
    }
  }
  return [...kinds];
}

function emptyCurrentToolCycleEvidence(): CurrentToolCycleEvidence {
  return {
    currentUserText: "",
    hasCurrentToolResult: false,
    hasSuccessfulCurrentToolResult: false,
    hasFailedCurrentToolResult: false,
    requiresEnvironmentToolResult: false,
    requiresActionToolResult: false,
    requiredActionKinds: [],
    fulfilledActionKinds: [],
    missingActionKinds: [],
    failedToolNames: [],
    failedToolFingerprints: [],
    hasUnavailableToolFailure: false,
  };
}

export function inspectCurrentToolCycle(
  messages: CanonicalMessage[],
  allowedToolNames: string[],
): CurrentToolCycleEvidence {
  let currentUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    const hasText = message.parts.some(part => part.type === "text" && Boolean(part.text?.trim()));
    const hasToolResult = message.parts.some(part => part.type === "tool_result");
    if (message.role === "user" && hasText && !hasToolResult) {
      currentUserIndex = index;
      break;
    }
  }
  if (currentUserIndex < 0) return emptyCurrentToolCycleEvidence();

  const currentUserText = messages[currentUserIndex]!.parts
    .filter(part => part.type === "text")
    .map(part => part.text ?? "")
    .filter(Boolean)
    .join("\n");
  const currentMessages = messages.slice(currentUserIndex + 1);
  const currentToolCalls = new Map<string, CanonicalToolCall>();
  for (const message of currentMessages) {
    for (const part of message.parts) {
      if (part.type === "tool_use" && part.toolCall?.id) currentToolCalls.set(part.toolCall.id, part.toolCall);
    }
  }

  let hasCurrentToolResult = false;
  let hasSuccessfulCurrentToolResult = false;
  let hasFailedCurrentToolResult = false;
  const fulfilledActionKinds = new Set<ExternalActionKind>();
  const failedToolNames = new Set<string>();
  const failedToolFingerprints = new Set<string>();
  for (const message of currentMessages) {
    for (const part of message.parts) {
      if (part.type !== "tool_result" || !part.toolResult) continue;
      const toolCall = currentToolCalls.get(part.toolResult.toolUseId);
      if (!toolCall) continue;
      hasCurrentToolResult = true;
      if (part.toolResult.isError) {
        hasFailedCurrentToolResult = true;
        failedToolNames.add(toolCall.name);
        failedToolFingerprints.add(toolCallFingerprint(toolCall.name, toolCall.arguments));
        continue;
      }
      hasSuccessfulCurrentToolResult = true;
      for (const kind of fulfilledKindsForTool(toolCall)) fulfilledActionKinds.add(kind);
    }
  }

  const requiredActionKinds = inferExternalActionKinds(currentUserText, allowedToolNames);
  const missingActionKinds = requiredActionKinds.filter(kind => !fulfilledActionKinds.has(kind));
  return {
    currentUserText,
    hasCurrentToolResult,
    hasSuccessfulCurrentToolResult,
    hasFailedCurrentToolResult,
    requiresEnvironmentToolResult: !hasSuccessfulCurrentToolResult
      && looksLikeEnvironmentDataRequest(currentUserText, allowedToolNames),
    requiresActionToolResult: missingActionKinds.length > 0,
    requiredActionKinds,
    fulfilledActionKinds: [...fulfilledActionKinds],
    missingActionKinds,
    failedToolNames: [...failedToolNames],
    failedToolFingerprints: [...failedToolFingerprints],
    hasUnavailableToolFailure: [...failedToolNames].some(name => name.toLowerCase() === "artifact"),
  };
}

const ACTION_SUCCESS_PATTERNS = /(?:готово|сделано|создал[аио]?|создан[аоы]?|изменил[аио]?|измен[её]н[аоы]?|удалил[аио]?|удал[её]н[аоы]?|запустил[аио]?|запущен[аоы]?|открыл[аио]?|открыт[аоы]?|установил[аио]?|установлен[аоы]?|выполнил[аио]?|выполнен[аоы]?|сохранил[аио]?|сохран[её]н[аоы]?|\b(?:done|created|modified|changed|deleted|removed|launched|started|opened|installed|executed|completed|saved)\b)/i;
const NEGATED_ACTION_SUCCESS = /(?:^|[\s:;,.-])не\s+(?:был(?:а|о|и)?\s+)?(?:готово|сделано|создан[аоы]?|измен[её]н[аоы]?|удал[её]н[аоы]?|запущен[аоы]?|открыт[аоы]?|установлен[аоы]?|выполнен[аоы]?|сохран[её]н[аоы]?)|\bnot\s+(?:been\s+)?(?:done|created|modified|changed|deleted|removed|launched|started|opened|installed|executed|completed|saved)\b/gi;

export function looksLikeActionSuccessClaim(content: string): boolean {
  const withoutNegatedClaims = content.replace(NEGATED_ACTION_SUCCESS, "");
  return ACTION_SUCCESS_PATTERNS.test(withoutNegatedClaims);
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

const FABRICATED_EXECUTION_CLAIMS: RegExp[] = [
  /(?:^|\n)\s*(?:я\s+)?(?:выполняю|выполнил|выполнял|запустил)[^\n]*(?:pwd|ls|команд)/im,
  /я\s+получил[\s\S]{0,180}выполнив[\s\S]{0,80}(?:pwd|ls|команд)/i,
  /\bi\s+(?:ran|executed)\b[^\n]*(?:pwd|ls|command)?/i,
  /\bi\s+(?:got|obtained)[\s\S]{0,180}\bby\s+(?:running|executing)\b/i,
];

function looksLikeFabricatedCommandOutput(content: string): boolean {
  if (FABRICATED_EXECUTION_CLAIMS.some(pattern => pattern.test(content))) return true;
  const hasCommandLine = /(?:^|\n)\s*(?:pwd|ls(?:\s+[^\r\n]+)?|get-childitem(?:\s+[^\r\n]+)?)\s*(?:\n|$)/im.test(content);
  const hasOutputLabel = /(?:^|\n)\s*(?:вывод|результат команды|command output|output)\s*:/im.test(content);
  const hasShellListing = /(?:^|\n)\s*total\s+\d+\s*(?:\n|$)/im.test(content)
    || /(?:^|\n)\s*[d-][rwx-]{9}\s+\d+\s+/m.test(content);
  return (hasCommandLine && (hasOutputLabel || hasShellListing))
    || (hasOutputLabel && hasShellListing);
}

// Detect "Tool: <name>\n{...json...}" multi-line fake traces.
// The tool name must match one of the allowed tools, and the next line
// must start with '{' (JSON arguments).
function looksLikeToolPrefixedFakeTrace(content: string, allowedToolNames: string[]): boolean {
  const allowed = new Set(allowedToolNames.map(n => n.toLowerCase()));
  const lines = content.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!.trim();
    const m = /^Tool:\s*(\S+)/i.exec(line);
    if (!m) continue;
    const name = m[1]!.toLowerCase();
    if (!allowed.has(name)) continue;
    const next = lines[i + 1]!.trim();
    if (next.startsWith("{")) return true;
  }
  return false;
}

export function looksLikeFakeToolTrace(content: string, allowedToolNames: string[]): boolean {
  if (allowedToolNames.length === 0) return false;
  const trimmed = content.trim();
  if (trimmed.length === 0) return false;

  const hasTools = allowedToolNames.some(n => {
    const lower = n.toLowerCase();
    return lower === "read" || lower === "write" || lower === "bash"
      || lower === "edit" || lower === "grep" || lower === "glob"
      || lower === "ls" || lower === "cat" || lower === "mkdir";
  });
  if (!hasTools) return false;

  if (looksLikeFabricatedCommandOutput(trimmed)) return true;
  if (trimmed.length > FAKE_TRACE_MAX_LENGTH) return false;

  // "Tool: <name>\n{json}" format — matches any allowed tool name
  if (looksLikeToolPrefixedFakeTrace(trimmed, allowedToolNames)) return true;

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

export interface ToolRetryPromptContext {
  unavailableToolNames?: string[];
  failedToolNames?: string[];
  missingActionKinds?: ExternalActionKind[];
  repeatedFailedToolName?: string;
}

export function createToolRetryPrompt(
  allowedNames: string[],
  context: ToolRetryPromptContext = {},
): string {
  const unavailable = context.unavailableToolNames ?? [];
  const lines = [
    "Your previous text did NOT execute any tool or establish successful completion of every requested action.",
    "You must not invent or simulate cwd, files, directory listings, command output, or tool results.",
    "A failed tool_result (is_error=true) is evidence of failure, not successful completion.",
  ];
  if (unavailable.some(name => name.toLowerCase() === "artifact")) {
    lines.push(
      "Artifact is unavailable through this Bridge session and cannot be used.",
      "The Artifact failure did not create, save, launch, or open anything.",
      "Do not claim success. Recover with ordinary available Claude Code tools such as Write, Edit, or Bash.",
    );
  }
  if ((context.failedToolNames ?? []).length > 0) {
    lines.push(`Failed tools in the current cycle: ${JSON.stringify(context.failedToolNames)}`);
  }
  if (context.repeatedFailedToolName) {
    lines.push(
      `The exact ${JSON.stringify(context.repeatedFailedToolName)} call with the same normalized arguments already ran in this user action cycle and returned tool_result is_error=true.`,
      "Do NOT repeat that call unchanged. Choose a different tool, correct the arguments, or honestly explain why the task cannot be completed.",
    );
  }
  if ((context.missingActionKinds ?? []).length > 0) {
    lines.push(`Still-unverified action kinds: ${JSON.stringify(context.missingActionKinds)}`);
  }
  lines.push(
    "For a request about the real environment or an external action, return a real tool_call JSON now.",
    "Output ONLY the JSON envelope below — nothing else:",
    '{"tool_call":{"name":"TOOL_NAME","arguments":{}}}',
    `Allowed tool names: ${JSON.stringify(allowedNames)}`,
    "No reasoning. No explanations. No Markdown. No text before or after.",
    "A success final answer is allowed only after the client sends a real tool_result marked successful in the current tool cycle for every requested action.",
    "If recovery is impossible after a real failure, report the failure honestly and do not claim the action succeeded.",
    "If no external action or environment data is requested, output only your final text answer.",
  );
  return lines.join("\n");
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

export function sanitizedToolInvocationText(name: string, callId: string): string {
  return `[Historical Tool Action — already executed/requested in the past.\nDO NOT execute this action again unless the CURRENT user request explicitly asks for it.]\ntool_name: ${JSON.stringify(String(name || "unknown"))}\ncall_id: ${JSON.stringify(String(callId || "unknown"))}\n[End Historical Tool Action]`;
}

export function toolResultText(name: string, callId: string, result: unknown, isError = false): string {
  const content = typeof result === "string" ? result : JSON.stringify(result ?? {});
  return `[Tool Result]\nname: ${name || "unknown"}\ncall_id: ${callId || "unknown"}\nstatus: ${isError ? "error" : "success"}\nis_error: ${isError}\nresult:\n${content}`;
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
    if (b.type === "tool_use") return sanitizedToolInvocationText(String(b.name || ""), String(b.id || ""));
    if (b.type === "tool_result") {
      const callId = String(b.tool_use_id || "");
      return toolResultText(sessionToolName(session, callId), callId, b.content, b.is_error === true);
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
