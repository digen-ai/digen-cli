import chalk from "chalk";
import type { Command } from "commander";
import { ApiError } from "../lib/errors.js";
import { handleCommandError, handleJsonError, isJson, printJson, success } from "../lib/output.js";
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
    .option("--bookmarked", "Only show bookmarked conversations", false)
    .option("--featured-status <status>", "Filter by homepage feature status")
    .action(
      async (opts: {
        limit: string;
        offset: string;
        bookmarked: boolean;
        featuredStatus?: string;
      }) => {
        if (!requireLogin()) {
          process.exitCode = 1;
          return;
        }
        const json = isJson(program);
        const client = getClient();
        try {
          const conversations = await client.listConversations(
            Number.parseInt(opts.limit, 10),
            Number.parseInt(opts.offset, 10),
            { bookmarkedOnly: opts.bookmarked, featuredStatus: opts.featuredStatus },
          );
          if (json) {
            printJson(conversations);
            return;
          }
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
          if (json) handleJsonError(err);
          else handleCommandError(err);
        }
      },
    );

  program
    .command("conversation")
    .description("Show a conversation's details")
    .argument("<conversationId>", "Conversation ID")
    .action(async (conversationId: string) => {
      if (!requireLogin()) {
        process.exitCode = 1;
        return;
      }
      const json = isJson(program);
      try {
        const data = await getClient().getConversation(conversationId);
        if (json) {
          printJson(data);
          return;
        }
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  program
    .command("history")
    .description("Print the message history for a conversation")
    .argument("<conversationId>", "Conversation ID")
    .option("-l, --limit <n>", "Page size")
    .option("-o, --offset <n>", "Skip the newest N messages")
    .option("--before <sequence>", "Only messages with sequence_number below this value")
    .action(
      async (
        conversationId: string,
        opts: {
          limit?: string;
          offset?: string;
          before?: string;
        },
      ) => {
        if (!requireLogin()) {
          process.exitCode = 1;
          return;
        }
        const json = isJson(program);
        const client = getClient();
        try {
          const data = await client.getConversationMessages(conversationId, {
            limit: opts.limit ? Number.parseInt(opts.limit, 10) : undefined,
            offset: opts.offset ? Number.parseInt(opts.offset, 10) : undefined,
            before: opts.before,
          });
          if (json) {
            printJson(data);
            return;
          }
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
          if (json) handleJsonError(err);
          else handleCommandError(err);
        }
      },
    );

  program
    .command("rename")
    .description("Rename a conversation")
    .argument("<conversationId>", "Conversation ID")
    .argument("<name>", "New name")
    .action(async (conversationId: string, name: string) => {
      if (!requireLogin()) {
        process.exitCode = 1;
        return;
      }
      const json = isJson(program);
      try {
        await getClient().renameConversation(conversationId, name);
        if (json) printJson({ ok: true, conversation_id: conversationId, name });
        else success(`Renamed ${conversationId} to ${name}`);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  program
    .command("set-workflow")
    .description("Update a pending conversation's workflow")
    .argument("<conversationId>", "Conversation ID")
    .argument("<workflow>", "Workflow name")
    .action(async (conversationId: string, workflow: string) => {
      if (!requireLogin()) {
        process.exitCode = 1;
        return;
      }
      const json = isJson(program);
      try {
        await getClient().updateConversationWorkflow(conversationId, workflow);
        if (json) printJson({ ok: true, conversation_id: conversationId, workflow });
        else success(`Workflow for ${conversationId} set to ${workflow}`);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
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
      const json = isJson(program);
      const client = getClient();
      try {
        await client.deleteConversation(conversationId);
        if (json) printJson({ ok: true, conversation_id: conversationId });
        else success(`Deleted ${conversationId}`);
      } catch (err) {
        if (json) handleJsonError(err);
        else if (err instanceof ApiError) handleCommandError(err);
        else handleCommandError(err);
      }
    });
}
