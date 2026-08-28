import chalk from "chalk";
import type { Command } from "commander";
import { getDefaultWorkflow } from "../lib/config.js";
import { ApiError } from "../lib/errors.js";
import { getClient, requireLogin } from "../lib/session.js";
import { runChatRepl } from "../ui/repl.js";
import { runChatTui } from "../ui/tui/index.js";

export function registerChatCommand(program: Command): void {
  program
    .command("chat")
    .description("Start an interactive chat session")
    .option("-w, --workflow <name>", "Workflow to use (default: configured default_workflow)")
    .option("-c, --conversation <id>", "Resume an existing conversation")
    .option("--no-images", "Show raw asset links as-is instead of resolving them to presigned URLs")
    .action(async (opts: { workflow?: string; conversation?: string; images?: boolean }) => {
      if (!requireLogin()) {
        process.exitCode = 1;
        return;
      }
      const client = getClient();
      const workflow = opts.workflow ?? getDefaultWorkflow();
      const images: "auto" | "off" =
        opts.images === false || process.env.DIGEN_IMAGES === "off" || !process.stdout.isTTY
          ? "off"
          : "auto";

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

      // The TUI needs a real keyboard (stdin) and screen (stdout) to drive
      // mouse hover/click; anything else (piped output, non-interactive
      // shells, SSH without a pty) falls back to the plain line-based REPL.
      const interactive = process.stdout.isTTY && process.stdin.isTTY;
      if (interactive) {
        await runChatTui({ client, conversationId, workflow: resolvedWorkflow, images });
      } else {
        await runChatRepl({ client, conversationId, workflow: resolvedWorkflow, images });
      }
    });
}
