import chalk from "chalk";
import type { Command } from "commander";
import { getDefaultWorkflow } from "../lib/config.js";
import { ApiError } from "../lib/errors.js";
import { getClient, requireLogin } from "../lib/session.js";
import { runChatRepl } from "../ui/repl.js";

export function registerChatCommand(program: Command): void {
  program
    .command("chat")
    .description("Start an interactive chat session")
    .option("-w, --workflow <name>", "Workflow to use (default: configured default_workflow)")
    .option("-c, --conversation <id>", "Resume an existing conversation")
    .action(async (opts: { workflow?: string; conversation?: string }) => {
      if (!requireLogin()) {
        process.exitCode = 1;
        return;
      }
      const client = getClient();
      const workflow = opts.workflow ?? getDefaultWorkflow();

      let conversationId = opts.conversation;
      let resolvedWorkflow = workflow;
      try {
        if (conversationId) {
          const conv = await client.getConversation(conversationId);
          resolvedWorkflow = (conv.workflow as string | undefined) ?? workflow;
        } else {
          const conv = await client.createConversation(workflow);
          conversationId = conv.conversation_id;
        }
      } catch (err) {
        console.error(chalk.red(err instanceof ApiError ? err.detail : String(err)));
        process.exitCode = 1;
        return;
      }

      await runChatRepl({ client, conversationId, workflow: resolvedWorkflow });
    });
}
