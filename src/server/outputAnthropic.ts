import type { CanonicalResult, CanonicalToolCall } from "../api/canonical.js";

export interface AnthropicContentBlock {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string;
  stop_sequence: null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

function toBlock(call: CanonicalToolCall): AnthropicContentBlock {
  return { type: "tool_use", id: call.id, name: call.name, input: call.arguments };
}

export function toAnthropicMessage(result: CanonicalResult, model: string): AnthropicMessageResponse {
  const content: AnthropicContentBlock[] = [];
  if (result.content) content.push({ type: "text", text: result.content });
  for (const call of result.toolCalls) content.push(toBlock(call));
  return {
    id: `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: result.toolCalls.length > 0 ? "tool_use" : (result.stopReason ?? "end_turn"),
    stop_sequence: null,
    usage: {
      input_tokens: result.usage?.promptTokens ?? 0,
      output_tokens: result.usage?.completionTokens ?? 0,
    },
  };
}

export function anthropicSseMessageStart(model: string, index: number): string {
  return `event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: {
      id: `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })}\n\n`;
}

export function anthropicSseContentDelta(delta: string): string {
  return `event: content_block_delta\ndata: ${JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: delta },
  })}\n\n`;
}

export function anthropicSseMessageDone(stopReason: "end_turn" | "tool_use" = "end_turn"): string {
  return `event: message_delta\ndata: ${JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 0 },
  })}\n\n`;
}

export function anthropicSseStop(): string {
  return `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
}
