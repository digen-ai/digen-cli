/**
 * In-memory registry of chat tasks started via the `digen_send` MCP tool.
 *
 * Each task's SSE stream is consumed in the background (the MCP server
 * process stays alive for the whole session, so this is safe), feeding a
 * `TurnAggregator`. `digen_poll` just reads the aggregator's current
 * snapshot — it never blocks on the network itself, which keeps every MCP
 * tool call fast regardless of how long the underlying Digen workflow
 * takes to finish.
 *
 * Mirrors the reconnect-on-drop behavior in `ui/tui/runTurn.ts` / `ui/repl.ts`.
 */

import type { ChatBlock, DigenClient } from "../lib/client.js";
import type { ChatEvent } from "../lib/sse.js";
import { type AggregatedTurn, TurnAggregator } from "./aggregate.js";

const MAX_RESUME_ATTEMPTS = 3;

export interface TaskRegistryOptions {
  /** Override reconnect backoff (ms). Used by tests to avoid sleeping. */
  resumeDelayMs?: (attempt: number) => number;
}

export interface TaskState {
  taskId: string;
  conversationId: string;
  workflow: string;
  aggregator: TurnAggregator;
  /** Resolves once the background consumer loop has stopped (terminal state or unrecoverable error). */
  done: Promise<void>;
  consumerError?: string;
}

export class TaskRegistry {
  private tasks = new Map<string, TaskState>();

  constructor(
    private client: DigenClient,
    private opts: TaskRegistryOptions = {},
  ) {}

  /** Starts a new conversation turn and begins consuming its SSE stream in the background. */
  async send(opts: {
    message: string;
    workflow: string;
    conversationId?: string;
  }): Promise<{ taskId: string; conversationId: string }> {
    const conversationId =
      opts.conversationId ?? (await this.client.createConversation(opts.workflow)).conversation_id;

    const blocks: ChatBlock[] = [{ type: "text", content: opts.message }];
    const { taskId, events } = await this.client.chatStream({
      blocks,
      conversationId,
      workflow: opts.workflow,
    });

    if (!taskId) {
      throw new Error("Digen did not return a task id for this chat request");
    }

    const aggregator = new TurnAggregator();
    const state: TaskState = {
      taskId,
      conversationId,
      workflow: opts.workflow,
      aggregator,
      done: Promise.resolve(),
    };
    state.done = this.consume(state, events);
    this.tasks.set(taskId, state);

    return { taskId, conversationId };
  }

  /** Returns the current aggregated snapshot for a task, resuming it from the server if unknown (e.g. after a restart). */
  async poll(taskId: string): Promise<AggregatedTurn & { consumerError?: string }> {
    const existing = this.tasks.get(taskId);
    if (existing) {
      return { ...existing.aggregator.result(), consumerError: existing.consumerError };
    }

    // Unknown task (e.g. the MCP server restarted): rebuild from scratch by
    // resuming the server-side stream from the beginning.
    const task = await this.client.getTask(taskId);
    const conversationId = String(task.conversation_id ?? "");
    const workflow = String(task.workflow ?? "");
    const aggregator = new TurnAggregator();
    const events = await this.client.resumeStream(taskId, 0);
    const state: TaskState = {
      taskId,
      conversationId,
      workflow,
      aggregator,
      done: Promise.resolve(),
    };
    state.done = this.consume(state, events);
    this.tasks.set(taskId, state);
    return { ...aggregator.result(), consumerError: state.consumerError };
  }

  get(taskId: string): TaskState | undefined {
    return this.tasks.get(taskId);
  }

  private async consume(state: TaskState, initialEvents: AsyncGenerator<ChatEvent>): Promise<void> {
    let current = initialEvents;
    let attempts = 0;

    while (true) {
      try {
        for await (const event of current) {
          state.aggregator.handle(event);
        }
        // Stream closed cleanly: if the server never sent a terminal event,
        // still mark the turn finished so pollers don't spin forever.
        state.aggregator.completeIfRunning();
        return;
      } catch (err) {
        if (attempts >= MAX_RESUME_ATTEMPTS) {
          state.consumerError = err instanceof Error ? err.message : String(err);
          return;
        }
        attempts += 1;
        const backoffMs = this.opts.resumeDelayMs?.(attempts) ?? 500 * 2 ** (attempts - 1);
        process.stderr.write(
          `digen-mcp: connection dropped for ${state.taskId}, reconnecting in ${backoffMs}ms…\n`,
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        try {
          current = await this.client.resumeStream(
            state.taskId,
            state.aggregator.result().lastSequence + 1,
          );
        } catch (resumeErr) {
          state.consumerError = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
          return;
        }
      }
    }
  }
}
