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
    const linkedUpstream = callId ? lineage.getUpstreamKey(callId) : undefined;
    const upstreamKey = explicitUpstream ?? linkedUpstream ?? `${clientIdentity}:${Date.now()}`;

    const state = sessionStore.getOrCreate(upstreamKey);
    sessionStore.touch(state);
    logger.info("request_identity", {
      client_identity: clientIdentity.slice(0, 32),
      upstream_has_explicit: Boolean(explicitUpstream),
      upstream_linked: Boolean(linkedUpstream),
    });

    const turn = 0;
    return this.mutex.withLock(upstreamKey, async () => {
      await deepseek.ensureSession(state);
      const toolNames = buildToolNames(request.tools);
      const textChunks: string[] = [];
      const reasoningChunks: string[] = [];
      const result = await deepseek.complete(
        request,
        state,
        {
          onText: delta => textChunks.push(delta),
          onReasoning: delta => reasoningChunks.push(delta),
        },
      );
      // If tool call found, discard all accumulated text (reasoning noise)
      if (result.toolCall) {
        textChunks.length = 0;
        reasoningChunks.length = 0;
      }
      if (!result.toolCall) {
        for (const chunk of reasoningChunks) {
          stream.push({ type: "thinking", text: chunk });
        }
        for (const chunk of textChunks) {
          stream.push({ type: "content", text: chunk });
        }
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
        stream.push({ type: "tool_use", toolCall: call });
        if (callId) {
          await lineage.record(callId, upstreamKey);
        }
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
    });
  }
}

export function maxLineageLinks(): number {
  return SESSION_LINK_MAX;
}

export function lineageTtlMs(): number {
  return SESSION_LINK_TTL_MS;
}
