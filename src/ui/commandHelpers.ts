/**
 * Slash-command output shared between the non-TTY REPL (`ui/repl.ts`) and the
 * interactive TUI (`ui/tui/`), so `/help`, `/history`, and error formatting
 * read identically in both.
 */

import chalk from "chalk";
import type { DigenClient } from "../lib/client.js";
import { ApiError } from "../lib/errors.js";
import { renderMarkdown } from "./render.js";

export function printHelp(): void {
  console.log(chalk.bold("\nSlash commands:"));
  console.log("  /new              start a new conversation");
  console.log("  /switch <id>      switch to an existing conversation");
  console.log("  /sessions         list your conversations");
  console.log("  /history          print this conversation's history");
  console.log("  /workflow [name]  show or change the workflow for new conversations");
  console.log("  /cancel           cancel the currently running task");
  console.log("  /confirm          confirm a pending await_confirmation prompt");
  console.log("  /help             show this help");
  console.log("  /quit             exit\n");
}

export function printApiError(err: ApiError): void {
  if (err.structured?.code === "CONVERSATION_BUSY") {
    console.error(chalk.red("A task is already running for this conversation. Try /cancel first."));
  } else if (err.structured?.code === "SESSION_QUOTA_EXCEEDED") {
    console.error(
      chalk.red(
        "You've reached your active-session limit. Finish or cancel another session first.",
      ),
    );
  } else {
    console.error(chalk.red(err.detail));
  }
}

export async function printHistory(client: DigenClient, conversationId: string): Promise<void> {
  try {
    const data = await client.getConversationMessages(conversationId);
    const messages = (data.messages ?? data.items ?? []) as Array<Record<string, unknown>>;
    if (messages.length === 0) {
      console.log(chalk.dim("No messages yet"));
      return;
    }
    for (const msg of messages) {
      const role = String(msg.role ?? "?");
      const blocks = (msg.blocks ?? msg.content ?? []) as Array<Record<string, unknown>>;
      const text = Array.isArray(blocks)
        ? blocks
            .filter((b) => b.type === "text")
            .map((b) => String(b.content ?? ""))
            .join("\n")
        : String(blocks);
      if (role === "user") {
        console.log(`${chalk.cyan.bold("you")}: ${text}`);
      } else {
        console.log(`${chalk.magenta.bold(role)}:`);
        console.log(renderMarkdown(text));
      }
    }
  } catch (err) {
    console.log(chalk.red(err instanceof ApiError ? err.detail : String(err)));
  }
}
