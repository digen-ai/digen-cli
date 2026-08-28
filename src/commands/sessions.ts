import chalk from "chalk";
import type { Command } from "commander";
import { ApiError } from "../lib/errors.js";
import { getClient, requireLogin } from "../lib/session.js";

function extractText(block: Record<string, unknown>): string | null {
  if (block.type === "text" && typeof block.content === "string") return block.content;
  return null;
}

export function registerSessionCommands(program: Command): void {
  program
    .command("sessions")
    .description("List your conversations")
    .option("-l, --limit <n>", "Max results", "50")
    .option("-o, --offset <n>", "Offset", "0")
    .action(async (opts: { limit: string; offset: string }) => {
      if (!requireLogin()) {
        process.exitCode = 1;
        return;
      }
      const client = getClient();
      try {
        const conversations = await client.listConversations(
          Number.parseInt(opts.limit, 10),
          Number.parseInt(opts.offset, 10),
        );
        if (conversations.length === 0) {
          console.log(chalk.yellow("No conversations yet. Run: digen chat"));
          return;
        }
        for (const conv of conversations) {
          const label = conv.name ? String(conv.name) : "(untitled)";
          console.log(
            `${chalk.bold(conv.conversation_id)}  ${chalk.cyan(conv.workflow)}  ${label}  ${chalk.dim(
              String(conv.updated_at ?? conv.created_at ?? ""),
            )}`,
          );
        }
      } catch (err) {
        if (err instanceof ApiError) {
          console.error(chalk.red(err.detail));
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  program
    .command("history")
    .description("Print the message history for a conversation")
    .argument("<conversationId>", "Conversation ID")
    .action(async (conversationId: string) => {
      if (!requireLogin()) {
        process.exitCode = 1;
        return;
      }
      const client = getClient();
      try {
        const data = await client.getConversationMessages(conversationId);
        const messages = (data.messages ?? data.items ?? []) as Array<Record<string, unknown>>;
        if (messages.length === 0) {
          console.log(chalk.yellow("No messages"));
          return;
        }
        for (const msg of messages) {
          const role = String(msg.role ?? "?");
          const label = role === "user" ? chalk.cyan("you") : chalk.magenta(role);
          const blocks = (msg.blocks ?? msg.content ?? []) as Array<Record<string, unknown>>;
          const text = Array.isArray(blocks)
            ? blocks.map(extractText).filter(Boolean).join("\n")
            : String(blocks);
          console.log(`${label}: ${text}`);
        }
      } catch (err) {
        if (err instanceof ApiError) {
          console.error(chalk.red(err.detail));
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  program
    .command("delete")
    .description("Delete a conversation")
    .argument("<conversationId>", "Conversation ID")
    .action(async (conversationId: string) => {
      if (!requireLogin()) {
        process.exitCode = 1;
        return;
      }
      const client = getClient();
      try {
        await client.deleteConversation(conversationId);
        console.log(chalk.green(`✔ Deleted ${conversationId}`));
      } catch (err) {
        if (err instanceof ApiError) {
          console.error(chalk.red(err.detail));
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });
}
