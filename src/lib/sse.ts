/**
 * SSE event parsing for the Digen chat protocol.
 *
 * Wire format: `data: {json}\n\n`, one JSON object per event, using
 * `sequence` to support disconnect/resume (see docs/API_REFERENCE.md
 * section 9 "SSE 事件协议" in vid-agent).
 */

import { EventSourceParserStream } from "eventsource-parser/stream";

export interface ChatEvent {
  sequence?: number;
  type: string;
  phase?: "start" | "end" | "progress" | "placeholder" | null;
  status?: "success" | "error" | "completed" | "cancelled" | null;
  agent?: string | null;
  agent_role?: "orchestrator" | "sub_agent" | "sub_orchestrator" | null;
  tool?: string | null;
  iteration?: number | null;
  content?: string | null;
  data?: Record<string, unknown> | null;
  timestamp?: string;
  [key: string]: unknown;
}

/**
 * Turn a fetch Response body into an async iterable of parsed chat events.
 * Malformed/empty lines (heartbeats) are silently skipped.
 */
export async function* parseChatEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatEvent> {
  const eventStream = body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onError: () => {} }));

  const reader = eventStream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (!value?.data) continue;
      try {
        const parsed = JSON.parse(value.data) as ChatEvent;
        yield parsed;
      } catch {
        // Ignore malformed payloads (e.g. keep-alive comments/newlines).
      }
    }
  } finally {
    reader.releaseLock();
  }
}
