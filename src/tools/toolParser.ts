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

interface ToolCallCandidateInspection {
  toolCall: CanonicalToolCall | null;
  reason: string;
}

export interface ToolCallOutputInspection {
  toolCall: CanonicalToolCall | null;
  reason: string;
  source: string;
  malformedToolIntent: boolean;
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

function extractToolCallFromText(text: string, allowedNames: string[]): ToolCallCandidateInspection {
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

function validateToolValue(value: unknown, allowedNames: string[]): ToolCallCandidateInspection {
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

function inspectToolCall(text: string, allowedNames: string[]): ToolCallCandidateInspection {
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

  const envelopeRecord = envelope as Record<string, unknown>;
  let value: unknown;
  if (tagMatch) {
    value = envelope;
  } else if (Object.prototype.hasOwnProperty.call(envelopeRecord, "tool_call")) {
    if (Object.keys(envelopeRecord).length !== 1) {
      return { toolCall: null, reason: "unexpected_envelope_keys" };
    }
    value = envelopeRecord.tool_call;
  } else if (Object.prototype.hasOwnProperty.call(envelopeRecord, "name")
    && Object.prototype.hasOwnProperty.call(envelopeRecord, "arguments")) {
    value = envelopeRecord;
  } else {
    return { toolCall: null, reason: "unexpected_envelope_keys" };
  }
  if (!isPlainObject(value)) return { toolCall: null, reason: "invalid_tool_shape" };

  return validateToolValue(value, allowedNames);
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function looksLikeMalformedToolIntent(content: string, allowedNames: string[]): boolean {
  if (allowedNames.length === 0 || typeof content !== "string") return false;
  const trimmed = content.trim();
  if (!trimmed || Buffer.byteLength(trimmed, "utf8") > MAX_TOOL_BYTES) return false;

  const allowedPattern = allowedNames.map(regexEscape).join("|");
  const jsonName = new RegExp(`["'](?:name|tool)["']\\s*:\\s*["'](?:${allowedPattern})["']`, "i");
  const tagName = new RegExp(`<tool_call\\b[^>]*\\bname\\s*=\\s*["'](?:${allowedPattern})["']`, "i");
  const prefixedName = new RegExp(`(?:^|\\n)\\s*Tool:\\s*(?:${allowedPattern})(?:\\s|$)`, "i");
  // OpenAI-style pseudo-XML envelope (<tool_calls><invoke name="...">...) is a
  // known model output format that the Bridge cannot execute as-is. Only an
  // executable shape counts: an <invoke> opening tag followed by a
  // <parameter> child. A bare quoted <invoke ...> in prose is not intent.
  const pseudoInvoke = new RegExp(`<invoke\\s+name\\s*=\\s*["'](?:${allowedPattern})["'][^>]*>\\s*<parameter\\b`, "i");
  const hasKnownName = jsonName.test(trimmed) || tagName.test(trimmed) || prefixedName.test(trimmed) || pseudoInvoke.test(trimmed);
  const hasNameField = /["'](?:name|tool)["']\s*:/.test(trimmed) || /<tool_call\b[^>]*\bname\s*=/.test(trimmed);
  const hasEnvelopeMarker = /["']tool_call["']\s*:|<tool_call\b/i.test(trimmed);
  const hasDirectShape = /["'](?:name|tool)["']\s*:/.test(trimmed) && /["']arguments["']\s*:/.test(trimmed);

  if (hasNameField) return hasKnownName && (hasEnvelopeMarker || hasDirectShape || prefixedName.test(trimmed));
  return hasEnvelopeMarker || prefixedName.test(trimmed) || pseudoInvoke.test(trimmed);
}

export function inspectToolCallFromOutput(
  output: { content?: string; reasoning?: string },
  allowedNames: string[],
): ToolCallOutputInspection {
  if (!output || typeof output.content !== "string") {
    return {
      toolCall: null,
      reason: "invalid_output",
      source: "none",
      malformedToolIntent: false,
    };
  }
  const rejected: ToolCallOutputInspection[] = [];
  if (output.content.trim()) {
    const result = inspectToolCall(output.content, allowedNames);
    if (result.toolCall) {
      return {
        ...result,
        source: "content",
        malformedToolIntent: false,
      };
    }
    rejected.push({
      ...result,
      source: "content",
      malformedToolIntent: looksLikeMalformedToolIntent(output.content, allowedNames),
    });
  }
  if (typeof output.reasoning === "string" && output.reasoning.trim()) {
    const result = inspectToolCall(output.reasoning, allowedNames);
    if (result.toolCall) {
      return {
        ...result,
        source: "reasoning",
        malformedToolIntent: false,
      };
    }
    rejected.push({
      ...result,
      source: "reasoning",
      malformedToolIntent: looksLikeMalformedToolIntent(output.reasoning, allowedNames),
    });
  }
  return rejected.find(result => result.malformedToolIntent) ?? {
    toolCall: null,
    reason: rejected[0]?.reason ?? "no_tool_call_found",
    source: rejected[0]?.source ?? "none",
    malformedToolIntent: false,
  };
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
  isInformationalRequest: boolean;
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
  obligations: ToolObligation[];
  fulfilledObligationIds: string[];
  missingObligations: ToolObligation[];
  staleObligations: ToolObligation[];
  inconclusiveObligations: ToolObligation[];
  cardinalityFailures: ObligationCardinalityFailure[];
  exactLiterals: string[];
  missingExactLiterals: string[];
}

export type ExternalActionKind =
  | "file_mutation"
  | "data_mutation"
  | "command_execution"
  | "api_verification"
  | "file_verification"
  | "test_execution"
  | "launch"
  | "server_verification"
  | "dependency_install";

type ExactLiteralRole = "title" | "description" | "content" | "marker" | "path" | "url" | "generic";

interface ExactUserLiteral {
  value: string;
  role: ExactLiteralRole;
}

export interface ToolObligation {
  id: string;
  kind: ExternalActionKind;
  description: string;
  argumentLiterals: string[];
  resultLiterals: string[];
  requiredExactResultCount?: number;
}

export interface ObligationCardinalityFailure {
  obligationId: string;
  expectedCount: number;
  observedCount: number;
}

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

function isInformationalRequest(content: string): boolean {
  const normalized = content.trim().toLowerCase().replace(/\s+/g, " ");
  return INFORMATIONAL_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

function hasToolMatching(allowedToolNames: string[], pattern: RegExp): boolean {
  return allowedToolNames.some(name => pattern.test(name.toLowerCase()));
}

export function looksLikeEnvironmentDataRequest(content: string, allowedToolNames: string[]): boolean {
  if (allowedToolNames.length === 0) return false;
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (isInformationalRequest(trimmed)) return false;

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
  if (isInformationalRequest(trimmed)) return [];

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
    && /(?:запуст\S*|открой\S*|подними\S*)[\s\S]{0,60}(?:сайт|сервер|приложен|лендинг|страниц|его|её|их)|(?:launch|start|open|serve)[\s\S]{0,60}(?:app|server|site|website|page|\b(?:it|them)\b)/i.test(trimmed);
  if (hasLauncher && launch) kinds.add("launch");

  if (hasShell && commandExecution) kinds.add("command_execution");

  return [...kinds];
}

function classifyLiteralRole(prefix: string): ExactLiteralRole | null {
  if (/(?:названи\S*|title|name)\s*[:=]?\s*$/i.test(prefix)) return "title";
  if (/(?:описани\S*|description)\s*[:=]?\s*$/i.test(prefix)) return "description";
  if (/(?:содержим\S*|content|text)\s*[:=]?\s*$/i.test(prefix)) return "content";
  if (/(?:маркер\S*|marker)\s*[:=]?\s*$/i.test(prefix)) return "marker";
  if (/(?:путь|path|file|файл\S*)\s*[:=]?\s*$/i.test(prefix)) return "path";
  if (/(?:url|адрес|endpoint)\s*[:=]?\s*$/i.test(prefix)) return "url";
  if (/(?:точн\S*|exact(?:ly)?|равн\S*|значени\S*)[\s\S]{0,24}$/i.test(prefix)) return "generic";
  return null;
}

function extractExactUserLiterals(content: string): ExactUserLiteral[] {
  const literals: ExactUserLiteral[] = [];
  const seen = new Set<string>();
  const quoted = /"([^"\r\n]{1,512})"|'([^'\r\n]{1,512})'|«([^»\r\n]{1,512})»|`([^`\r\n]{1,512})`/g;
  for (const match of content.matchAll(quoted)) {
    const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    const prefix = content.slice(Math.max(0, (match.index ?? 0) - 64), match.index);
    const role = classifyLiteralRole(prefix);
    const normalized = value.normalize("NFC");
    if (!role || !normalized.trim() || seen.has(normalized)) continue;
    seen.add(normalized);
    literals.push({ value, role });
    if (literals.length >= 8) return literals;
  }

  const labeledContent = /(?:^|\n)\s*(title|название|description|описание)\s*:?\s*(?:\r?\n\s*)?([^\r\n]{1,512})/gi;
  for (const match of content.matchAll(labeledContent)) {
    const label = (match[1] ?? "").toLowerCase();
    const value = (match[2] ?? "").trim();
    const role: ExactLiteralRole = /title|название/.test(label) ? "title" : "description";
    const normalized = value.normalize("NFC");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    literals.push({ value, role });
    if (literals.length >= 8) return literals;
  }

  const labeled = /(?:путь|path)\s*[:=]\s*([^\s,;]+)|(?:url|адрес|endpoint)\s*[:=]\s*(https?:\/\/[^\s,;]+)/gi;
  for (const match of content.matchAll(labeled)) {
    const value = match[1] ?? match[2] ?? "";
    const normalized = value.normalize("NFC");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    literals.push({ value, role: match[1] ? "path" : "url" });
    if (literals.length >= 8) return literals;
  }

  const pathLike = /(?:^|[\s(])((?:[A-Za-z]:\\[^\r\n"'<>|?*]+|(?:[\w.-]+[\\/])*[\w.-]+\.(?:json|md|txt|html?|jsx?|tsx?|ya?ml|toml)))(?=$|[\s),.;])/g;
  for (const match of content.matchAll(pathLike)) {
    const value = match[1] ?? "";
    const normalized = value.normalize("NFC");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    literals.push({ value, role: "path" });
    if (literals.length >= 8) break;
  }
  return literals;
}

function literalValues(literals: ExactUserLiteral[], roles: ExactLiteralRole[]): string[] {
  const allowed = new Set(roles);
  return literals.filter(literal => allowed.has(literal.role)).map(literal => literal.value);
}

function obligationDescription(kind: ExternalActionKind, argumentLiterals: string[], resultLiterals: string[]): string {
  const exact = [...argumentLiterals, ...resultLiterals]
    .filter((value, index, values) => values.indexOf(value) === index)
    .map(value => JSON.stringify(value));
  const suffix = exact.length > 0 ? ` with exact values ${exact.join(", ")}` : "";
  switch (kind) {
    case "file_mutation": return `perform the requested file mutation${suffix}`;
    case "data_mutation": return `create or update the requested data${suffix}`;
    case "command_execution": return `execute the requested command${suffix}`;
    case "api_verification": return `verify the result through the API${suffix}`;
    case "file_verification": return `read and verify the requested storage/file${suffix}`;
    case "test_execution": return `run the requested test suite${suffix}`;
    case "launch": return "launch or leave the requested application/server running";
    case "server_verification": return "verify that the application/server is responding";
    case "dependency_install": return "install the requested dependencies";
  }
}

export function inferToolObligations(content: string, allowedToolNames: string[]): ToolObligation[] {
  if (allowedToolNames.length === 0 || isInformationalRequest(content)) return [];
  const hasShell = hasToolMatching(allowedToolNames, /bash|shell|powershell|terminal|command|exec/);
  const literals = extractExactUserLiterals(content);
  const contentLiterals = literalValues(literals, ["title", "description", "content", "marker", "generic"]);
  const pathLiterals = literalValues(literals, ["path"]);
  const urlLiterals = literalValues(literals, ["url"]);
  const kinds = new Set<ExternalActionKind>(inferExternalActionKinds(content, allowedToolNames));

  const dataMutation = /(?:созда\S*|добав\S*|измен\S*|обнов\S*|create|add|update|change)[\s\S]{0,100}(?:задач|запис|данн|task|record|item)/i.test(content);
  if (hasShell && dataMutation) {
    kinds.add("data_mutation");
    const explicitFileMutation = /(?:созда\S*|сделай|сохран\S*|запиш\S*|измен\S*|отредактир\S*|удал\S*|create|make|save|write|modify|change|edit|delete)[\s\S]{0,48}(?:файл|server\.[a-z0-9_-]+|\b[\w.-]+\.(?:json|md|txt|html?|jsx?|tsx?)\b)/i.test(content);
    if (!explicitFileMutation) kinds.delete("file_mutation");
  }

  const apiVerification = /(?:проверь|проверить|провер\S*|убед\S*|verify|check|inspect)[\s\S]{0,100}(?:через\s+api|\bapi\b|endpoint)|(?:через\s+api|via\s+(?:the\s+)?api)[\s\S]{0,80}(?:проверь|verify|check)?/i.test(content);
  if (hasShell && apiVerification) kinds.add("api_verification");

  const fileVerification = /(?:проверь|проверить|провер\S*|прочитай|прочесть|убед\S*|verify|check|read|inspect)[\s\S]{0,100}(?:файл\S*\s+хранен|storage\s+(?:file|json)|json[- ]?файл|\b[\w.-]+\.json\b|\b[\w.-]+\.(?:md|txt|html?|jsx?|tsx?)\b)/i.test(content);
  if (fileVerification && hasToolMatching(allowedToolNames, /read|cat|bash|shell|powershell|command|exec/)) {
    kinds.add("file_verification");
  }

  const testExecution = /(?:запуст\S*|выполн\S*|прогон\S*|снова\s+запуст\S*|run|execute|rerun)[\s\S]{0,60}(?:тест|tests?|jest|vitest|pytest)|\b(?:npm\s+(?:run\s+)?test|jest|vitest|pytest)\b/i.test(content);
  if (hasShell && testExecution) kinds.add("test_execution");

  const serverVerification = /(?:проверь|проверить|провер\S*|убед\S*|verify|check|ensure)[\s\S]{0,100}(?:сервер|приложен|server|app)[\s\S]{0,80}(?:отвеч|работ|доступ|respond|running|reachable|health)|(?:сервер|приложен|server|app)[\s\S]{0,80}(?:отвеч|respond|reachable|health)|остав\S*[\s\S]{0,80}(?:прилож|сервер)[\s\S]{0,40}(?:работ|запущ)|leave[\s\S]{0,60}(?:app|server)[\s\S]{0,40}(?:running|up)/i.test(content);
  if (hasShell && serverVerification) kinds.add("server_verification");

  const requiresExactlyOne = /(?:ровно|точно)\s+одн(?:у|о|ой)?(?=\s|[.,:;!?]|$)|\bexactly\s+one\b|\ba\s+single\b/i.test(content);
  const titleDescriptionLiterals = new Set(
    literalValues(literals, ["title", "description"]).map(value => value.normalize("NFC")),
  );

  return [...kinds].map(kind => {
    let argumentLiterals: string[] = [];
    let resultLiterals: string[] = [];
    if (kind === "file_mutation") {
      // API payload fields belong to data_mutation; a file mutation is identified
      // by its path/marker, not by request body fields shared with the POST.
      const fileContentLiterals = kinds.has("data_mutation")
        ? contentLiterals.filter(value => !titleDescriptionLiterals.has(value.normalize("NFC")))
        : contentLiterals;
      argumentLiterals = [...fileContentLiterals, ...pathLiterals.slice(0, 1), ...urlLiterals];
    } else if (kind === "data_mutation" || kind === "command_execution") {
      argumentLiterals = [...contentLiterals, ...urlLiterals];
    } else if (kind === "api_verification") {
      argumentLiterals = urlLiterals;
      resultLiterals = contentLiterals;
    } else if (kind === "file_verification") {
      argumentLiterals = pathLiterals;
      resultLiterals = contentLiterals;
    } else if (kind === "test_execution") {
      argumentLiterals = literalValues(literals, ["generic"])
        .filter(value => /test|jest|vitest|pytest/i.test(value));
    } else if (kind === "launch") {
      argumentLiterals = [];
    } else if (kind === "server_verification") {
      argumentLiterals = urlLiterals;
    }
    const requiredExactResultCount = requiresExactlyOne
      && resultLiterals.length > 0
      && (kind === "api_verification" || kind === "file_verification")
      ? 1
      : undefined;
    return {
      id: kind,
      kind,
      description: obligationDescription(kind, argumentLiterals, resultLiterals)
        + (requiredExactResultCount === 1 ? " occurring exactly once in the final state" : ""),
      argumentLiterals,
      resultLiterals,
      requiredExactResultCount,
    };
  });
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

function collectStringValues(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectStringValues(item, output);
  }
  return output;
}

function containsExactUnicode(values: string[], literal: string): boolean {
  const normalizedLiteral = literal.normalize("NFC");
  return values.some(value => value.normalize("NFC").includes(normalizedLiteral));
}

function parseToolResultJson(resultContent: string): unknown | undefined {
  const candidates = [
    resultContent,
    resultContent.split(/\r?\n/).map(line => line.replace(/^\s*\d+\s*[→│|:]?\s*/, "")).join("\n"),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Only deterministic representations are repaired; ambiguous output must be re-verified.
    }
  }
  return undefined;
}

function resultContainsExactUnicode(resultContent: string, literal: string): boolean {
  const parsed = parseToolResultJson(resultContent);
  if (parsed !== undefined) {
    const normalizedLiteral = literal.normalize("NFC");
    return collectStringValues(parsed).some(value => value.normalize("NFC") === normalizedLiteral);
  }
  return containsExactUnicode([resultContent], literal);
}

function resultMatchesObligationLiterals(obligation: ToolObligation, resultContent: string): boolean {
  return obligation.resultLiterals.every(literal => resultContainsExactUnicode(resultContent, literal));
}

function isContainerJson(resultContent: string): boolean {
  const parsed = parseToolResultJson(resultContent);
  return Array.isArray(parsed) || (parsed !== null && typeof parsed === "object");
}

function countExactRecords(value: unknown, literals: string[]): number {
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + countExactRecords(item, literals), 0);
  }
  if (!value || typeof value !== "object") return 0;

  const record = value as Record<string, unknown>;
  const directStrings = Object.values(record).filter((item): item is string => typeof item === "string");
  const isExactRecord = literals.every(literal => directStrings.some(
    value => value.normalize("NFC") === literal.normalize("NFC"),
  ));
  let nestedCount = 0;
  for (const item of Object.values(record)) nestedCount += countExactRecords(item, literals);
  return (isExactRecord ? 1 : 0) + nestedCount;
}

function observedExactResultCount(obligation: ToolObligation, resultContent: string): number | undefined {
  if (obligation.requiredExactResultCount === undefined || obligation.resultLiterals.length === 0) return undefined;
  const parsed = parseToolResultJson(resultContent);
  return parsed === undefined ? undefined : countExactRecords(parsed, obligation.resultLiterals);
}

function resultSatisfiesCardinality(obligation: ToolObligation, resultContent: string): boolean {
  if (obligation.requiredExactResultCount === undefined) return true;
  return observedExactResultCount(obligation, resultContent) === obligation.requiredExactResultCount;
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
  const argumentStrings = collectStringValues(toolCall.arguments);
  const command = argumentStrings.join("\n");
  const kinds = new Set<ExternalActionKind>();
  const isShell = /bash|shell|powershell|terminal|command|exec/.test(name);
  const isApiCommand = /\b(?:curl|wget)\b|\bfetch\s*\(|\binvoke-(?:restmethod|webrequest)\b|https?:\/\/|\/api\//i.test(command);
  const isApiMutation = isApiCommand
    && /(?:\s-X|--request|\bmethod\s*:)\s*["']?(?:POST|PUT|PATCH|DELETE)\b|\bMethod\s+(?:POST|PUT|PATCH|DELETE)\b/i.test(command);
  const isTestExecution = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnpx\s+(?:jest|vitest)\b|(?:^|[\s;&])(?:jest|vitest|pytest)(?:[\s;&]|$)/i.test(command)
    && !/(?:--version|--help|--listTests|(?:^|\s)-v(?:\s|$))/i.test(command);

  if (/write|edit|create|delete|remove|rename|move|copy/.test(name)) {
    kinds.add("file_mutation");
  }
  if (/^(?:read|cat)$|read.?file/.test(name)) kinds.add("file_verification");
  if (/browser|open|launch/.test(name)) kinds.add("launch");
  if (/install|package/.test(name)) kinds.add("dependency_install");
  if (isShell) {
    kinds.add("command_execution");
    if (/(?:^|[\s;&|])>>?\s*|\b(?:tee|touch|mkdir|rm|mv|cp|del|copy|move|remove-item|new-item|set-content|add-content|out-file)\b/i.test(args)) {
      kinds.add("file_mutation");
    }
    if (/\b(?:start|open|xdg-open|explorer|start-process|invoke-item)\b|\bpython(?:3)?\s+-m\s+http\.server\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:start|dev|preview)\b|\bnpx\s+(?:vite|serve|http-server)\b|\bnode\s+(?!-e\b|--eval\b)[^;\r\n]+/i.test(command)) {
      kinds.add("launch");
    }
    if (/\b(?:npm|pnpm|yarn|bun)\s+(?:install|add)\b|\bpip(?:3)?\s+install\b|\b(?:brew|apt(?:-get)?|dnf|yum)\s+install\b/i.test(command)) {
      kinds.add("dependency_install");
    }
    if (isTestExecution) {
      kinds.add("test_execution");
    }
    if (isApiMutation) kinds.add("data_mutation");
    if (isApiCommand && !isApiMutation) kinds.add("api_verification");
    if (/\b(?:cat|type|get-content|read-file)\b[^\r\n]*(?:\.json\b|storage|data[\\/])/i.test(command)) {
      kinds.add("file_verification");
    }
    if (isApiCommand && !isApiMutation && /(?:localhost|127\.0\.0\.1|\[::1\])/i.test(command)) {
      kinds.add("server_verification");
    }
  }
  return [...kinds];
}

function isFinalStateObligation(obligation: ToolObligation): boolean {
  return obligation.kind === "api_verification"
    || obligation.kind === "file_verification"
    || obligation.kind === "server_verification";
}

function isBuildCommand(toolCall: CanonicalToolCall): boolean {
  if (!/bash|shell|powershell|terminal|command|exec/i.test(toolCall.name)) return false;
  const command = collectStringValues(toolCall.arguments).join("\n");
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\b(?:tsc|vite|webpack|rollup|esbuild)\b/i.test(command);
}

function invalidatesFinalState(obligation: ToolObligation, toolCall: CanonicalToolCall): boolean {
  if (!isFinalStateObligation(obligation)) return false;
  const kinds = new Set(fulfilledKindsForTool(toolCall));
  const changesPersistentState = kinds.has("file_mutation")
    || kinds.has("data_mutation")
    || kinds.has("test_execution")
    || kinds.has("dependency_install")
    || isBuildCommand(toolCall);
  if (obligation.kind === "server_verification") {
    return kinds.has("launch") || kinds.has("dependency_install") || isBuildCommand(toolCall);
  }
  if (obligation.kind === "api_verification") return changesPersistentState || kinds.has("launch");
  return changesPersistentState;
}

function fulfillsObligation(
  obligation: ToolObligation,
  toolCall: CanonicalToolCall,
  resultContent: string,
): boolean {
  if (!fulfilledKindsForTool(toolCall).includes(obligation.kind)) return false;
  if (looksLikeStructuredToolError(resultContent)) return false;
  if (looksLikeFailedObligationOutput(obligation.kind, resultContent)) return false;
  if (obligation.kind === "test_execution" && looksLikeFailedTestOutput(resultContent)) return false;
  const argumentStrings = collectStringValues(toolCall.arguments);
  if (!obligation.argumentLiterals.every(literal => containsExactUnicode(argumentStrings, literal))) return false;
  return resultMatchesObligationLiterals(obligation, resultContent)
    && resultSatisfiesCardinality(obligation, resultContent);
}

function looksLikeFailedObligationOutput(kind: ExternalActionKind, content: string): boolean {
  if (kind === "launch") {
    return /\bEADDRINUSE\b|\b(?:failed|unable) to (?:start|launch|open)\b/i.test(content);
  }
  if (kind === "api_verification" || kind === "server_verification") {
    return /\b(?:ECONNREFUSED|ENOTFOUND)\b|\bserver (?:is )?not (?:responding|ready|running|reachable)\b|\b(?:connection refused|failed to connect|could(?:n't| not) connect)\b|\bHTTP\/?\d(?:\.\d)?\s+[45]\d\d\b/i.test(content);
  }
  if (kind === "file_verification") {
    return /\b(?:ENOENT|no such file(?: or directory)?|file not found|cannot find (?:the )?(?:file|path))\b/i.test(content);
  }
  return false;
}

function looksLikeStructuredToolError(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as unknown;
    return isPlainObject(parsed)
      && "error" in (parsed as Record<string, unknown>)
      && Boolean((parsed as Record<string, unknown>).error);
  } catch {
    return false;
  }
}

function looksLikeFailedTestOutput(content: string): boolean {
  return /(?:^|\n)\s*FAIL\b|\b(?:test suites?|tests?)\s*:\s*[^\r\n]*\bfailed\b|\b\d+\s+(?:tests?\s+)?failed\b|\bfailed\s+(?:tests?|test suites?)\b/i.test(content);
}

export function looksLikePromisedActionContinuation(content: string): boolean {
  return /(?:^|[.!?]\s+)(?:let me|i(?:'ll| will)|next,?\s+i(?:'ll| will))\s+(?:start|run|rerun|retry|check|verify|fix|create|update|continue|inspect|read|open)\b/i.test(content)
    || /(?:^|[.!?]\s+)(?:\u0434\u0430\u0439(?:\u0442\u0435)?\s+(?:\u044f\s+)?|\u0441\u0435\u0439\u0447\u0430\u0441\s+(?:\u044f\s+)?|\u044f\s+)(?:\u0437\u0430\u043f\u0443\u0449\u0443|\u043f\u0435\u0440\u0435\u0437\u0430\u043f\u0443\u0449\u0443|\u043f\u043e\u0432\u0442\u043e\u0440\u044e|\u043f\u0440\u043e\u0432\u0435\u0440\u044e|\u0438\u0441\u043f\u0440\u0430\u0432\u043b\u044e|\u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0443|\u043e\u0442\u043a\u0440\u043e\u044e|\u043f\u0440\u043e\u0447\u0438\u0442\u0430\u044e)\b/i.test(content);
}

function emptyCurrentToolCycleEvidence(): CurrentToolCycleEvidence {
  return {
    currentUserText: "",
    isInformationalRequest: false,
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
    obligations: [],
    fulfilledObligationIds: [],
    missingObligations: [],
    staleObligations: [],
    inconclusiveObligations: [],
    cardinalityFailures: [],
    exactLiterals: [],
    missingExactLiterals: [],
  };
}

export interface ObligationEvidenceRef {
  toolCall: CanonicalToolCall;
  resultContent: string;
  sequence: number;
}

// One-to-one binding within each ExternalActionKind: a single successful
// evidence item closes at most one obligation instance of the same kind, while
// different instances may be closed by different items. Evidence remains
// shareable across different kinds. Augmenting paths keep the matching maximal
// when earlier obligations could fall back to other evidence. Obligations must
// have unique ids; single-instance inference keeps the historical bare-kind id.
export function matchObligationsToEvidence(
  obligations: ToolObligation[],
  evidence: ObligationEvidenceRef[],
): Map<number, ObligationEvidenceRef> {
  const matches = new Map<number, ObligationEvidenceRef>();
  if (obligations.length === 0 || evidence.length === 0) return matches;

  const tryBind = (obligationIndex: number, visited: Set<number>, ownerByEvidence: Map<number, number>): boolean => {
    if (visited.has(obligationIndex)) return false;
    visited.add(obligationIndex);
    const obligation = obligations[obligationIndex]!;
    // Latest-first scan keeps historical freshness semantics: a final-state
    // obligation binds to its newest satisfying evidence, mirroring the
    // previous "any match newer than the last invalidation" behavior.
    for (let e = evidence.length - 1; e >= 0; e--) {
      const candidate = evidence[e]!;
      if (!fulfillsObligation(obligation, candidate.toolCall, candidate.resultContent)) continue;
      const previousOwner = ownerByEvidence.get(e);
      if (previousOwner === undefined) {
        matches.set(obligationIndex, candidate);
        ownerByEvidence.set(e, obligationIndex);
        return true;
      }
      if (tryBind(previousOwner, visited, ownerByEvidence)) {
        matches.set(obligationIndex, candidate);
        ownerByEvidence.set(e, obligationIndex);
        return true;
      }
    }
    return false;
  };

  const kindGroups = new Map<ExternalActionKind, number[]>();
  obligations.forEach((obligation, index) => {
    const group = kindGroups.get(obligation.kind) ?? [];
    group.push(index);
    kindGroups.set(obligation.kind, group);
  });
  for (const group of kindGroups.values()) {
    // Ownership is scoped per kind: within a kind an evidence item serves at
    // most one instance, while different kinds may share the same item.
    const ownerByEvidence = new Map<number, number>();
    for (const obligationIndex of group) tryBind(obligationIndex, new Set(), ownerByEvidence);
  }
  return matches;
}

export function inspectCurrentToolCycle(
  messages: CanonicalMessage[],
  allowedToolNames: string[],
): CurrentToolCycleEvidence {
  let currentUserIndex = -1;
  let currentUserText = "";
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    const actionText = message.parts
      .filter(part => part.type === "text")
      .map(part => part.text ?? "")
      .join("\n")
      .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, "")
      .trim();
    const hasToolResult = message.parts.some(part => part.type === "tool_result");
    if (message.role === "user" && actionText && !hasToolResult) {
      currentUserIndex = index;
      currentUserText = actionText;
      break;
    }
  }
  if (currentUserIndex < 0) return emptyCurrentToolCycleEvidence();

  const obligations = inferToolObligations(currentUserText, allowedToolNames);
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
  const successfulEvidence: Array<{ toolCall: CanonicalToolCall; resultContent: string; sequence: number }> = [];
  const completedEvidence: Array<{ toolCall: CanonicalToolCall; sequence: number }> = [];
  let sequence = 0;
  for (const message of currentMessages) {
    for (const part of message.parts) {
      sequence++;
      if (part.type !== "tool_result" || !part.toolResult) continue;
      const toolCall = currentToolCalls.get(part.toolResult.toolUseId);
      if (!toolCall) continue;
      completedEvidence.push({ toolCall, sequence });
      hasCurrentToolResult = true;
      if (part.toolResult.isError) {
        hasFailedCurrentToolResult = true;
        failedToolNames.add(toolCall.name);
        failedToolFingerprints.add(toolCallFingerprint(toolCall.name, toolCall.arguments));
        continue;
      }
      hasSuccessfulCurrentToolResult = true;
      successfulEvidence.push({ toolCall, resultContent: part.toolResult.content, sequence });
      for (const kind of fulfilledKindsForTool(toolCall)) fulfilledActionKinds.add(kind);
    }
  }

  const staleObligations: ToolObligation[] = [];
  const inconclusiveObligations: ToolObligation[] = [];
  const cardinalityFailures: ObligationCardinalityFailure[] = [];
  const boundEvidence = matchObligationsToEvidence(obligations, successfulEvidence);
  const fulfilledObligationIds = obligations.filter((obligation, obligationIndex) => {
    const lastInvalidation = isFinalStateObligation(obligation)
      ? completedEvidence.reduce((latest, evidence) => (
        invalidatesFinalState(obligation, evidence.toolCall) ? Math.max(latest, evidence.sequence) : latest
      ), -1)
      : -1;
    // Per-kind one-to-one binding: the matched item for this instance cannot
    // simultaneously satisfy another instance of the same kind.
    const boundItem = boundEvidence.get(obligationIndex);
    const matchingEvidence: ObligationEvidenceRef[] = boundItem ? [boundItem] : [];
    if (matchingEvidence.some(evidence => evidence.sequence > lastInvalidation)) return true;

    const freshVerificationEvidence = successfulEvidence.filter(evidence => (
      evidence.sequence > lastInvalidation
      && fulfilledKindsForTool(evidence.toolCall).includes(obligation.kind)
      && !looksLikeStructuredToolError(evidence.resultContent)
      && !looksLikeFailedObligationOutput(obligation.kind, evidence.resultContent)
    ));
    // Exact-count is judged only on relevant verification output: results that
    // contain the requested literals or are container-shaped JSON. Health probes,
    // pwd and other scalar/unrelated outputs never participate in counting.
    const relevantFreshVerification = freshVerificationEvidence.filter(evidence =>
      resultMatchesObligationLiterals(obligation, evidence.resultContent)
      || isContainerJson(evidence.resultContent),
    );
    const latestRelevant = relevantFreshVerification.at(-1);
    if (latestRelevant !== undefined && obligation.requiredExactResultCount !== undefined) {
      const observedCount = observedExactResultCount(obligation, latestRelevant.resultContent);
      if (observedCount === undefined) {
        inconclusiveObligations.push(obligation);
      } else if (observedCount !== obligation.requiredExactResultCount) {
        cardinalityFailures.push({
          obligationId: obligation.id,
          expectedCount: obligation.requiredExactResultCount,
          observedCount,
        });
      }
    }
    if (isFinalStateObligation(obligation)
      && matchingEvidence.some(evidence => evidence.sequence <= lastInvalidation)
      && freshVerificationEvidence.length === 0) {
      staleObligations.push(obligation);
    }
    return false;
  }).map(obligation => obligation.id);
  const fulfilledIds = new Set(fulfilledObligationIds);
  const missingObligations = obligations.filter(obligation => !fulfilledIds.has(obligation.id));
  const requiredActionKinds = obligations.map(obligation => obligation.kind);
  const missingActionKinds = missingObligations.map(obligation => obligation.kind);
  const exactLiterals = [...new Set(obligations.flatMap(obligation => [
    ...obligation.argumentLiterals,
    ...obligation.resultLiterals,
  ]))];
  const missingExactLiterals = [...new Set(missingObligations.flatMap(obligation => [
    ...obligation.argumentLiterals,
    ...obligation.resultLiterals,
  ]))];
  return {
    currentUserText,
    isInformationalRequest: isInformationalRequest(currentUserText),
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
    obligations,
    fulfilledObligationIds,
    missingObligations,
    staleObligations,
    inconclusiveObligations,
    cardinalityFailures,
    exactLiterals,
    missingExactLiterals,
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
  missingObligations?: string[];
  fulfilledObligations?: string[];
  staleObligations?: string[];
  inconclusiveObligations?: string[];
  cardinalityFailures?: ObligationCardinalityFailure[];
  repeatedFailedToolName?: string;
  malformedToolIntent?: boolean;
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
  if (context.malformedToolIntent) {
    lines.push(
      "Your previous output was a malformed tool call. The tool was NOT executed.",
      "Do not describe the action as text. Return exactly one correct tool call using valid JSON.",
      "Every backslash inside a JSON string must be correctly escaped (use \\\\ for a literal backslash).",
    );
  }
  if ((context.missingActionKinds ?? []).length > 0) {
    lines.push(`Still-unverified action kinds: ${JSON.stringify(context.missingActionKinds)}`);
    if (context.missingActionKinds?.includes("data_mutation")) {
      lines.push("Claude Code TaskCreate and TaskUpdate only manage Claude's internal task list; they do NOT create or update data in the user's application. Use an application-facing tool action for this requirement.");
    }
  }
  if ((context.missingObligations ?? []).length > 0) {
    lines.push(
      `Still-unverified current-user requirements: ${JSON.stringify(context.missingObligations)}`,
      "Do not claim success. Use real tools to complete only these missing requirements.",
    );
  }
  if ((context.staleObligations ?? []).length > 0) {
    lines.push(
      `Stale final-state verifications: ${JSON.stringify(context.staleObligations)}`,
      "A later state-changing action made that evidence stale. Re-check the final state now with a fresh GET, Read, or health request as appropriate.",
      "Do NOT repeat an already successful mutation or POST merely because its verification became stale.",
    );
  }
  if ((context.inconclusiveObligations ?? []).length > 0) {
    lines.push(
      `Unresolved exact-count verifications: ${JSON.stringify(context.inconclusiveObligations)}`,
      "The latest verification output could not be deterministically counted. Run the verification again now (a fresh GET or Read) and return its raw JSON output so the exact record count can be checked.",
      "Do NOT repeat an already successful mutation or POST.",
    );
  }
  if ((context.cardinalityFailures ?? []).length > 0) {
    lines.push(
      `Final-state exact-cardinality failures: ${JSON.stringify(context.cardinalityFailures)}`,
      "The final state must contain the requested exact record the required number of times. Reconcile the current state safely; never create a duplicate blindly.",
    );
  }
  if ((context.fulfilledObligations ?? []).length > 0) {
    lines.push(
      `Already verified requirements: ${JSON.stringify(context.fulfilledObligations)}`,
      "Do not repeat already verified steps unless a missing requirement genuinely depends on doing so.",
    );
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
