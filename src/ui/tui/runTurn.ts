/**
 * Sends one user message and streams the response into a `TranscriptStore`,
 * transparently resuming from the last sequence number if the connection
 * drops (mirrors the reconnect behavior the non-TTY REPL has always had).
 */

import chalk from "chalk";
import type { DigenClient } from "../../lib/client.js";
import type { ChatEvent } from "../../lib/sse.js";
import type { TranscriptStore, TurnOutcome } from "../transcript.js";

const MAX_RESUME_ATTEMPTS = 3;

export async function runTurn(
  client: DigenClient,
  conversationId: string,
  workflow: string,
  text: string,
  store: TranscriptStore,
  signal: AbortSignal,
  onTaskId: (taskId: string | null) => void,
): Promise<void> {
  const { taskId, events } = await client.chatStream({
    blocks: [{ type: "text", content: text }],
    conversationId,
    workflow,
    signal,
  });
  onTaskId(taskId);
  await consumeWithResume(client, taskId, events, store, signal, onTaskId);
}

async function consumeWithResume(
  client: DigenClient,
  taskId: string | null,
  events: AsyncGenerator<ChatEvent>,
  store: TranscriptStore,
  signal: AbortSignal,
  onTaskId: (taskId: string | null) => void,
): Promise<void> {
  let lastSequence = 0;
  let current = events;
  let attempts = 0;

  while (true) {
    let outcome: TurnOutcome = { kind: "continue" };
    try {
      for await (const event of current) {
        if (typeof event.sequence === "number") lastSequence = event.sequence;
        outcome = store.handle(event);
        if (outcome.kind === "done" || outcome.kind === "error") return;
      }
      return; // stream ended without an explicit done/error event
    } catch (err) {
      if (signal.aborted) return;
      if (!taskId || attempts >= MAX_RESUME_ATTEMPTS) throw err;
      attempts += 1;
      const backoffMs = 500 * 2 ** (attempts - 1);
      console.log(chalk.dim(`Connection dropped, reconnecting in ${backoffMs}ms…`));
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      current = await client.resumeStream(taskId, lastSequence + 1, signal);
      onTaskId(taskId);
    }
  }
}
