import type { CanonicalChunk, CanonicalToolCall } from "../api/canonical.js";
import type { Protocol } from "../api/normalizeByProtocol.js";
import { anthropicSseContentDelta, anthropicSseMessageDone, anthropicSseMessageStart, anthropicSseStop } from "./outputAnthropic.js";
import { openaiSseChunk, openaiSseDone } from "./outputOpenAI.js";
import { responsesSseDone, responsesSseOutputText } from "./outputResponses.js";

export class ProtocolStream {
  private readonly model: string;
  private blockIndex = 0;

  constructor(
    private readonly protocol: Protocol,
    model: string,
    private readonly write: (data: string) => void,
  ) {
    this.model = model;
  }

  start(): void {
    if (this.protocol === "anthropic") {
      this.write(anthropicSseMessageStart(this.model, 0));
    }
  }

  push(chunk: CanonicalChunk): void {
    if (chunk.type === "content") {
      if (chunk.text) {
        if (this.protocol === "openai") this.write(openaiSseChunk(0, chunk.text));
        if (this.protocol === "anthropic") this.write(anthropicSseContentDelta(chunk.text));
        if (this.protocol === "responses") this.write(responsesSseOutputText(chunk.text));
      }
      return;
    }
    if (chunk.type === "thinking") {
      if (this.protocol === "anthropic" && chunk.text) {
        const idx = this.blockIndex++;
        this.write(`event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: idx,
          content_block: { type: "thinking", thinking: "" },
        })}\n\n`);
        this.write(`event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: idx,
          delta: { type: "thinking_delta", thinking: chunk.text },
        })}\n\n`);
        this.write(`event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: idx,
        })}\n\n`);
      }
      return;
    }
    if (chunk.type === "tool_use") {
      const call = chunk.toolCall as CanonicalToolCall | undefined;
      if (!call) return;
      if (this.protocol === "openai") {
        this.write(openaiSseChunk(0, JSON.stringify({
          tool_calls: [{
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          }],
        })));
      }
      if (this.protocol === "anthropic") {
        const idx = this.blockIndex;
        this.write(`event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: idx,
          content_block: { type: "tool_use", id: call.id, name: call.name },
        })}\n\n`);
        this.write(`event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: idx,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(call.arguments) },
        })}\n\n`);
        this.write(`event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: idx,
        })}\n\n`);
        this.blockIndex++;
      }
    }
  }

  finish(): void {
    if (this.protocol === "openai") this.write(openaiSseDone(0));
    if (this.protocol === "anthropic") {
      this.write(anthropicSseMessageDone());
      this.write(anthropicSseStop());
    }
    if (this.protocol === "responses") this.write(responsesSseDone());
  }
}
