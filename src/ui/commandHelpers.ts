/**
 * Slash-command output shared between the non-TTY REPL (`ui/repl.ts`) and the
 * interactive TUI (`ui/tui/`), so `/help`, `/history`, and error formatting
 * read identically in both.
 */

import chalk from "chalk";
import type { DigenClient } from "../lib/client.js";
import { ApiError } from "../lib/errors.js";
import type { InvokableSkill } from "../lib/skillsInvoke.js";
import { renderMarkdown } from "./render.js";

/** Built-in chat commands. Anything else starting with `/` may be a skill invocation. */
export const CHAT_SLASH_COMMANDS = new Set([
  "quit",
  "exit",
  "help",
  "new",
  "switch",
  "sessions",
  "history",
  "workflow",
  "skills",
  "cancel",
  "confirm",
  "attach",
  "attachments",
  "detach",
]);

/**
 * Parses a line into a built-in slash command. Returns `null` for regular
 * messages and for `/name` tokens that belong to skills (or typos) — those
 * are handled by `SkillInvoker`.
 */
export function parseChatSlashCommand(line: string): { cmd: string; arg: string } | null {
  if (!line.startsWith("/")) return null;
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  if (!cmd || !CHAT_SLASH_COMMANDS.has(cmd)) return null;
  return { cmd, arg: rest.join(" ").trim() };
}

export function printHelp(): void {
  console.log(chalk.bold("\nSlash commands:"));
  console.log("  /new              start a new conversation");
  console.log("  /switch <id>      switch to an existing conversation");
  console.log("  /sessions         list your conversations");
  console.log("  /history          print this conversation's history");
  console.log("  /workflow [name]  show or change the workflow for new conversations");
  console.log("  /skills           list skills you can invoke with /name (--refresh to reload)");
  console.log("  /attach <path>    stage a local image/video/audio/document for the next message");
  console.log("  /attachments      list staged attachments");
  console.log("  /detach [n|all]   remove a staged attachment (default: all)");
  console.log("  /cancel           cancel the currently running task");
  console.log("  /confirm          confirm a pending await_confirmation prompt");
  console.log("  /help             show this help");
  console.log("  /quit             exit");
  console.log(chalk.dim("\nType /<skill-name> anywhere in a message to invoke that skill.\n"));
}

export function printSkillList(skills: InvokableSkill[]): void {
  if (skills.length === 0) {
    console.log(chalk.dim("No skills available. Browse and install skills with `digen skill`."));
    return;
  }
  console.log(chalk.bold("\nSkills you can invoke (type /<name> in a message):"));
  const width = Math.max(...skills.map((skill) => skill.name.length)) + 1;
  for (const skill of skills) {
    const name = `/${skill.name}`.padEnd(width + 1);
    const label = skill.displayName && skill.displayName !== skill.name ? skill.displayName : "";
    const suffix = skill.enabled ? "" : chalk.dim(" (disabled)");
    console.log(`  ${chalk.cyan(name)} ${label}${suffix}`);
  }
  console.log();
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
