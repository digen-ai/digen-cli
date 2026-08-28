/**
 * Interactive chat loop: reads lines from stdin, sends them as chat
 * messages, and streams the SSE response through `ChatRenderer`. Handles
 * slash commands, Ctrl-C task cancellation, and reconnect-on-drop via the
 * `/chat/resume` endpoint.
 */

import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import type { DigenClient } from "../lib/client.js";
import { ApiError } from "../lib/errors.js";
import type { ChatEvent } from "../lib/sse.js";
import { printApiError, printHelp, printHistory } from "./commandHelpers.js";
import { ChatRenderer, type TurnOutcome } from "./render.js";

const MAX_RESUME_ATTEMPTS = 3;

export interface ReplOptions {
  client: DigenClient;
  conversationId: string;
  workflow: string;
  images?: "auto" | "off";
}

export async function runChatRepl(opts: ReplOptions): Promise<void> {
  let { conversationId, workflow } = opts;
  const { client } = opts;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const renderer = new ChatRenderer({ client, images: opts.images ?? "auto" });
  let activeController: AbortController | null = null;
  let activeTaskId: string | null = null;

  const onSigint = () => {
    if (activeController) {
      renderer.finishLine();
      console.log(chalk.yellow("\nCancelling…"));
      activeController.abort();
      const taskId = activeTaskId;
      activeController = null;
      activeTaskId = null;
      if (taskId) {
        void client.cancelTask(taskId).catch(() => {});
      }
    } else {
      console.log(chalk.dim("\nBye!"));
      rl.close();
      process.exit(0);
    }
  };
  process.on("SIGINT", onSigint);

  console.log(chalk.dim(`Conversation ${conversationId} · workflow ${workflow}`));
  console.log(
    chalk.dim("Type your message and press Enter. /help for commands, Ctrl-C to cancel/quit.\n"),
  );

  try {
    while (true) {
      let line: string;
      try {
        line = (await rl.question(chalk.cyan("> "))).trim();
      } catch {
        break; // stdin closed (Ctrl-D)
      }
      if (!line) continue;

      if (line.startsWith("/")) {
        const [cmd, ...rest] = line.slice(1).split(/\s+/);
        const arg = rest.join(" ").trim();
        switch (cmd) {
          case "quit":
          case "exit":
            rl.close();
            return;
          case "help":
            printHelp();
            continue;
          case "new": {
            const conv = await client.createConversation(workflow);
            conversationId = conv.conversation_id;
            console.log(chalk.green(`✔ New conversation ${conversationId}`));
            continue;
          }
          case "switch": {
            if (!arg) {
              console.log(chalk.yellow("Usage: /switch <conversationId>"));
              continue;
            }
            try {
              const conv = await client.getConversation(arg);
              conversationId = arg;
              workflow = (conv.workflow as string | undefined) ?? workflow;
              console.log(chalk.green(`✔ Switched to ${conversationId} (${workflow})`));
            } catch (err) {
              console.log(chalk.red(err instanceof ApiError ? err.detail : String(err)));
            }
            continue;
          }
          case "sessions": {
            const conversations = await client.listConversations();
            for (const conv of conversations) {
              console.log(
                `${conv.conversation_id}  ${chalk.cyan(conv.workflow)}  ${conv.name ?? ""}`,
              );
            }
            continue;
          }
          case "history": {
            await printHistory(client, conversationId);
            continue;
          }
          case "workflow": {
            if (arg) {
              workflow = arg;
              console.log(chalk.green(`✔ Workflow for new messages set to ${workflow}`));
            } else {
              console.log(`Current workflow: ${chalk.cyan(workflow)}`);
            }
            continue;
          }
          case "cancel": {
            if (activeTaskId) {
              await client.cancelTask(activeTaskId).catch(() => {});
              console.log(chalk.yellow("✔ Cancel requested"));
            } else {
              console.log(chalk.dim("No task is running"));
            }
            continue;
          }
          case "confirm": {
            if (activeTaskId) {
              await client.confirmCountdown(activeTaskId, "confirm").catch(() => {});
            } else {
              console.log(chalk.dim("No task is awaiting confirmation"));
            }
            continue;
          }
          default:
            console.log(chalk.yellow(`Unknown command: /${cmd} (try /help)`));
            continue;
        }
      }

      activeController = new AbortController();
      try {
        await sendMessage(
          client,
          conversationId,
          workflow,
          line,
          renderer,
          activeController.signal,
          (id) => {
            activeTaskId = id;
          },
        );
      } catch (err) {
        renderer.finishLine();
        if (err instanceof ApiError) {
          printApiError(err);
        } else if (!(err instanceof Error && err.name === "AbortError")) {
          console.error(chalk.red(String(err)));
        }
      } finally {
        activeController = null;
        activeTaskId = null;
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
    rl.close();
  }
}

async function sendMessage(
  client: DigenClient,
  conversationId: string,
  workflow: string,
  text: string,
  renderer: ChatRenderer,
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
  await consumeWithResume(client, taskId, events, renderer, signal, onTaskId);
}

/** Consume an event stream, transparently resuming from the last sequence on drop. */
async function consumeWithResume(
  client: DigenClient,
  taskId: string | null,
  events: AsyncGenerator<ChatEvent>,
  renderer: ChatRenderer,
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
        outcome = renderer.handle(event);
        if (outcome.kind === "done" || outcome.kind === "error") {
          if (!signal.aborted) await renderer.flushAssets();
          return;
        }
      }
      if (!signal.aborted) await renderer.flushAssets();
      return; // stream ended without an explicit done/error event
    } catch (err) {
      if (signal.aborted) return;
      if (!taskId || attempts >= MAX_RESUME_ATTEMPTS) throw err;
      attempts += 1;
      const backoffMs = 500 * 2 ** (attempts - 1);
      renderer.finishLine();
      console.log(chalk.dim(`Connection dropped, reconnecting in ${backoffMs}ms…`));
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      current = await client.resumeStream(taskId, lastSequence + 1, signal);
      onTaskId(taskId);
    }
  }
}
