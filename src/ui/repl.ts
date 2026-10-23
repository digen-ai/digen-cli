/**
 * Interactive chat loop: reads lines from stdin, sends them as chat
 * messages, and streams the SSE response through `ChatRenderer`. Handles
 * slash commands, Ctrl-C task cancellation, and reconnect-on-drop via the
 * `/chat/resume` endpoint.
 */

import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import type { ChatBlock, DigenClient } from "../lib/client.js";
import { ApiError } from "../lib/errors.js";
import {
  type ResolvedSkillInvocation,
  SkillInvoker,
  leadingSkillToken,
} from "../lib/skillsInvoke.js";
import type { ChatEvent } from "../lib/sse.js";
import {
  type StagedAttachment,
  buildMessageBlocks,
  formatBytes,
  stageAttachment,
  waitForDocumentBlocks,
} from "../lib/uploads.js";
import {
  parseChatSlashCommand,
  printApiError,
  printHelp,
  printHistory,
  printSkillList,
} from "./commandHelpers.js";
import { ChatRenderer, type TurnOutcome } from "./render.js";

const MAX_RESUME_ATTEMPTS = 3;

export interface ReplOptions {
  client: DigenClient;
  conversationId: string;
  workflow: string;
  images?: "auto" | "off";
  attachments?: StagedAttachment[];
  /** Sent as the first turn before the prompt; the session stays open afterward. */
  message?: string;
  /** Defaults to `process.stdin`. Tests pass a stream that can be closed. */
  input?: NodeJS.ReadableStream;
}

export async function runChatRepl(opts: ReplOptions): Promise<void> {
  let { conversationId, workflow } = opts;
  const { client } = opts;

  const input = opts.input ?? process.stdin;
  // Default terminal detection follows stdout. A piped stdin with a TTY stdout
  // would then ignore EOF, so key off the input stream instead.
  const rl = createInterface({
    input,
    output: process.stdout,
    terminal: Boolean((input as NodeJS.ReadStream).isTTY),
  });
  let inputClosed = false;
  rl.on("close", () => {
    inputClosed = true;
  });
  const renderer = new ChatRenderer({ client, images: opts.images ?? "auto" });
  const skillInvoker = new SkillInvoker(client);
  let activeController: AbortController | null = null;
  let activeTaskId: string | null = null;
  let staged: StagedAttachment[] = [...(opts.attachments ?? [])];

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

  /** Returns false when the session should end (`/quit`, `/exit`). */
  const dispatchLine = async (line: string): Promise<boolean> => {
    const command = parseChatSlashCommand(line);
    if (command) {
      const { cmd, arg } = command;
      switch (cmd) {
        case "quit":
        case "exit":
          return false;
        case "help":
          printHelp();
          return true;
        case "new": {
          const conv = await client.createConversation(workflow);
          conversationId = conv.conversation_id;
          console.log(chalk.green(`✔ New conversation ${conversationId}`));
          return true;
        }
        case "switch": {
          if (!arg) {
            console.log(chalk.yellow("Usage: /switch <conversationId>"));
            return true;
          }
          try {
            const conv = await client.getConversation(arg);
            conversationId = arg;
            workflow = (conv.workflow as string | undefined) ?? workflow;
            console.log(chalk.green(`✔ Switched to ${conversationId} (${workflow})`));
          } catch (err) {
            console.log(chalk.red(err instanceof ApiError ? err.detail : String(err)));
          }
          return true;
        }
        case "sessions": {
          const conversations = await client.listConversations();
          for (const conv of conversations) {
            console.log(
              `${conv.conversation_id}  ${chalk.cyan(conv.workflow)}  ${conv.name ?? ""}`,
            );
          }
          return true;
        }
        case "history": {
          await printHistory(client, conversationId);
          return true;
        }
        case "workflow": {
          if (arg) {
            workflow = arg;
            console.log(chalk.green(`✔ Workflow for new messages set to ${workflow}`));
          } else {
            console.log(`Current workflow: ${chalk.cyan(workflow)}`);
          }
          return true;
        }
        case "skills": {
          try {
            printSkillList(
              await skillInvoker.list({ refresh: arg === "refresh" || arg === "--refresh" }),
            );
          } catch (err) {
            console.log(chalk.red(err instanceof ApiError ? err.detail : String(err)));
          }
          return true;
        }
        case "cancel": {
          if (activeTaskId) {
            await client.cancelTask(activeTaskId).catch(() => {});
            console.log(chalk.yellow("✔ Cancel requested"));
          } else {
            console.log(chalk.dim("No task is running"));
          }
          return true;
        }
        case "confirm": {
          if (activeTaskId) {
            await client.confirmCountdown(activeTaskId, "confirm").catch(() => {});
          } else {
            console.log(chalk.dim("No task is awaiting confirmation"));
          }
          return true;
        }
        case "attach": {
          if (!arg) {
            console.log(chalk.yellow("Usage: /attach <path>"));
            return true;
          }
          try {
            const attachment = stageAttachment(arg);
            staged.push(attachment);
            console.log(
              chalk.green(
                `✔ Attached ${attachment.name} (${formatBytes(attachment.size)}) — ${staged.length} attachment${staged.length === 1 ? "" : "s"} staged`,
              ),
            );
          } catch (err) {
            console.log(chalk.red(err instanceof Error ? err.message : String(err)));
          }
          return true;
        }
        case "attachments": {
          if (staged.length === 0) {
            console.log(chalk.dim("No attachments staged"));
          } else {
            staged.forEach((attachment, i) => {
              console.log(
                `  ${i + 1}. ${attachment.name} (${formatBytes(attachment.size)}, ${attachment.assetType})`,
              );
            });
          }
          return true;
        }
        case "detach": {
          if (!arg || arg === "all") {
            const count = staged.length;
            staged = [];
            console.log(chalk.green(`✔ Detached ${count} attachment${count === 1 ? "" : "s"}`));
          } else {
            const index = Number.parseInt(arg, 10);
            if (!Number.isInteger(index) || index < 1 || index > staged.length) {
              console.log(chalk.yellow(`Usage: /detach [n|all] (1-${staged.length || 0})`));
            } else {
              const [removed] = staged.splice(index - 1, 1);
              console.log(chalk.green(`✔ Detached ${removed?.name}`));
            }
          }
          return true;
        }
        default:
          return true;
      }
    }

    let invocation: ResolvedSkillInvocation;
    try {
      invocation = await skillInvoker.resolve(line);
    } catch (err) {
      console.log(chalk.red(err instanceof ApiError ? err.detail : String(err)));
      return true;
    }
    if (line.startsWith("/") && invocation.invoked.length === 0) {
      const leading = leadingSkillToken(line);
      if (leading && invocation.disabled.includes(leading)) {
        console.log(
          chalk.yellow(
            `Skill /${leading} is disabled. Re-enable it with \`digen skill enable <id>\`.`,
          ),
        );
      } else {
        const [cmd] = line.slice(1).split(/\s+/);
        console.log(chalk.yellow(`Unknown command or skill: /${cmd} (try /help or /skills)`));
      }
      return true;
    }

    activeController = new AbortController();
    try {
      const blocks = await buildMessageBlocks(
        client,
        conversationId,
        staged,
        line,
        (attachment, index, total) => {
          console.log(chalk.dim(`↑ Uploading ${attachment.name} (${index + 1}/${total})…`));
        },
        invocation.blocks,
      );
      await waitForDocumentBlocks(client, conversationId, blocks);
      await sendMessage(
        client,
        conversationId,
        workflow,
        blocks,
        renderer,
        activeController.signal,
        (id) => {
          activeTaskId = id;
        },
      );
      staged = [];
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
    return true;
  };

  /** `question()` stays pending after the interface closes unless aborted. */
  async function readPrompt(): Promise<string> {
    if (inputClosed) throw new Error("readline closed");
    const ac = new AbortController();
    const onClose = () => ac.abort();
    rl.once("close", onClose);
    try {
      return await rl.question(chalk.cyan("> "), { signal: ac.signal });
    } finally {
      rl.off("close", onClose);
    }
  }

  try {
    const opening = opts.message?.trim();
    if (opening) {
      console.log(`${chalk.cyan("> ")}${opening}`);
      const keepGoing = await dispatchLine(opening);
      if (!keepGoing) return;
    }

    while (true) {
      let line: string;
      try {
        line = (await readPrompt()).trim();
      } catch {
        break; // stdin closed (Ctrl-D)
      }
      if (!line && staged.length === 0) continue;
      const keepGoing = await dispatchLine(line);
      if (!keepGoing) return;
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
  blocks: ChatBlock[],
  renderer: ChatRenderer,
  signal: AbortSignal,
  onTaskId: (taskId: string | null) => void,
): Promise<void> {
  const { taskId, events } = await client.chatStream({
    blocks,
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
