import { MAX_UPSTREAM_RETRIES, SESSION_LINK_MAX, SESSION_LINK_TTL_MS } from "../config/constants.js";
import { BridgeError } from "../utils/errors.js";
import type { Logger } from "../utils/logger.js";
import type { CanonicalRequest, CanonicalResult } from "./canonical.js";
import type { Protocol } from "./normalizeByProtocol.js";
import type { DeepSeekClient } from "../deepseek/client.js";
import { KeyedMutex } from "../sessions/mutex.js";
import type { SessionStore } from "../sessions/sessionStore.js";
import { resolveClientIdentity, resolveUpstreamIdentity } from "../sessions/sessionResolver.js";
import { LineageStore } from "../sessions/lineage.js";
import { buildToolPrompt } from "../tools/toolPrompt.js";
import { buildToolNames } from "../deepseek/client.js";
import type { ProtocolStream } from "../server/protocolStream.js";
import type { CanonicalToolCall } from "./canonical.js";

export function extractToolUseIdFromMessages(request: CanonicalRequest): string | undefined {
  let currentUserIndex = -1;
  for (let index = request.messages.length - 1; index >= 0; index--) {
    const message = request.messages[index]!;
    const actionText = message.parts
      .filter(part => part.type === "text")
      .map(part => part.text ?? "")
      .join("\n")
      .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, "")
      .trim();
    const hasToolResult = message.parts.some(part => part.type === "tool_result");
    if (message.role === "user" && actionText && !hasToolResult) {
      currentUserIndex = index;
      break;
    }
  }
  if (currentUserIndex < 0) return undefined;

  for (let messageIndex = request.messages.length - 1; messageIndex > currentUserIndex; messageIndex--) {
    const message = request.messages[messageIndex]!;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex--) {
      const part = message.parts[partIndex]!;
      if (part.type === "tool_result" && part.toolResult?.toolUseId) return part.toolResult.toolUseId;
    }
  }
  return undefined;
}

export interface HandlerOptions {
  deepseek: DeepSeekClient;
  sessionStore: SessionStore;
  lineage: LineageStore;
  logger: Logger;
}

export interface RunRequest {
  protocol: Protocol;
  request: CanonicalRequest;
  headers: Record<string, string | undefined>;
  body: Record<string, unknown>;
  stream: ProtocolStream;
}

export interface RunResult {
  result: CanonicalResult;
  upstreamKey: string;
  streamed: boolean;
}

export class CompletionHandler {
  private readonly mutex = new KeyedMutex();

  constructor(private readonly options: HandlerOptions) {}

  async run(input: RunRequest): Promise<RunResult> {
    const { deepseek, sessionStore, lineage, logger } = this.options;
    const { request, protocol, headers, body, stream } = input;

    const clientIdentity = resolveClientIdentity(headers);
    const explicitUpstream = resolveUpstreamIdentity(body);
    const callId = typeof headers["x-call-id"] === "string" ? headers["x-call-id"] : undefined;
    const toolResultUseId = extractToolUseIdFromMessages(request);
    let linkedUpstream: string | undefined;
    if (!explicitUpstream) {
      const headerUpstream = callId ? lineage.getUpstreamKey(callId) : undefined;
      const toolResultUpstream = toolResultUseId ? lineage.getUpstreamKey(toolResultUseId) : undefined;
      if (headerUpstream && toolResultUpstream && headerUpstream !== toolResultUpstream) {
        throw new BridgeError("Request lineage identifiers resolve to different upstream sessions.", {
          code: "SESSION_CONFLICT",
          status: 409,
        });
      }
      linkedUpstream = headerUpstream ?? toolResultUpstream;
    }
    const upstreamKey = explicitUpstream ?? linkedUpstream ?? `${clientIdentity}:${Date.now()}`;

    const state = sessionStore.getOrCreate(upstreamKey);
    sessionStore.touch(state);
    logger.info("request_identity", {
      client_identity: clientIdentity.slice(0, 32),
      upstream_has_explicit: Boolean(explicitUpstream),
      upstream_linked: Boolean(linkedUpstream),
    });

    const turn = 0;
    const authGeneration = deepseek.getAuthGeneration?.() ?? 0;
    return this.mutex.withLock(upstreamKey, async () => {
      try {
        await deepseek.ensureSession(state, authGeneration);
        const toolNames = buildToolNames(request.tools);
        stream.start();
        const result = await deepseek.complete(request, state, {}, authGeneration);
        if (!result.toolCall && result.content) {
          stream.push({ type: "content", text: result.content });
        }
        sessionStore.appendHistory(state, {
          role: "assistant",
          content: result.content,
          messageId: state.parentMessageId ?? undefined,
        });
        if (result.toolCall && toolNames.has(result.toolCall.name)) {
          const id = `call_${Math.random().toString(36).slice(2, 10)}`;
          const call: CanonicalToolCall = {
            id,
            type: "function",
            name: result.toolCall.name,
            arguments: result.toolCall.args,
          };
          await lineage.record(id, upstreamKey);
          if (callId && callId !== id) {
            await lineage.record(callId, upstreamKey);
          }
          stream.push({ type: "tool_use", toolCall: call });
          stream.finish();
          return {
            result: {
              content: result.content,
              toolCalls: [{ id, type: "function" as const, name: result.toolCall.name, arguments: result.toolCall.args }],
              usage: result.usage,
            },
            upstreamKey,
            streamed: true,
          };
        }
        stream.finish();
        return {
          result: {
            content: result.content,
            toolCalls: [],
            usage: result.usage,
          },
          upstreamKey,
          streamed: true,
        };
      } catch (error) {
        if (error instanceof BridgeError && (error.code === "DEEPSEEK_HTTP_401" || error.code === "DEEPSEEK_HTTP_403")) {
          sessionStore.reset(upstreamKey);
          await lineage.removeByUpstreamKey(upstreamKey);
          logger.warn("auth_expired_session_reset", { code: error.code, status: error.status });
        }
        throw error;
      }
    });
  }
}

export function maxLineageLinks(): number {
  return SESSION_LINK_MAX;
}

export function lineageTtlMs(): number {
  return SESSION_LINK_TTL_MS;
}
