import chalk from "chalk";
import type { Command } from "commander";
import { handleCommandError, handleJsonError, isJson, printJson, success } from "../lib/output.js";
import { getClient, requireLogin } from "../lib/session.js";

export function registerTaskCommands(program: Command): void {
  program
    .command("tasks")
    .description("List your active tasks")
    .option("--type <type>", "Filter by task type (chat, parsing, nsfw_scan, ...)")
    .action(async (opts: { type?: string }) => {
      if (!requireLogin()) {
        process.exitCode = 1;
        return;
      }
      const json = isJson(program);
      try {
        const tasks = await getClient().listActiveTasks(opts.type);
        if (json) {
          printJson(tasks);
          return;
        }
        if (tasks.length === 0) {
          console.log(chalk.yellow("No active tasks"));
          return;
        }
        for (const task of tasks) {
          console.log(
            `${chalk.bold(String(task.task_id ?? "?"))}  ${String(task.status ?? "?")}  ${String(task.task_type ?? "")}  ${String(task.conversation_id ?? "")}`,
          );
        }
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  const task = program
    .command("task [taskId]")
    .description("Show a task, or manage it with cancel/signal")
    .action(async (taskId?: string) => {
      if (!taskId) {
        console.error(chalk.yellow("Usage: digen task <taskId> | digen task cancel <taskId>"));
        process.exitCode = 1;
        return;
      }
      if (!requireLogin()) {
        process.exitCode = 1;
        return;
      }
      const json = isJson(program);
      try {
        const data = await getClient().getTask(taskId);
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

  task
    .command("cancel <taskId>")
    .description("Cancel a running task")
    .action(async (taskId: string) => {
      if (!requireLogin()) {
        process.exitCode = 1;
        return;
      }
      const json = isJson(program);
      try {
        await getClient().cancelTask(taskId);
        if (json) printJson({ ok: true, task_id: taskId });
        else success(`Cancel requested for ${taskId}`);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  task
    .command("signal <taskId> <action>")
    .description("Send confirm/cancel for an await_confirmation task")
    .action(async (taskId: string, action: string) => {
      if (action !== "confirm" && action !== "cancel") {
        console.error(chalk.red("action must be confirm or cancel"));
        process.exitCode = 1;
        return;
      }
      if (!requireLogin()) {
        process.exitCode = 1;
        return;
      }
      const json = isJson(program);
      try {
        await getClient().confirmCountdown(taskId, action);
        if (json) printJson({ ok: true, task_id: taskId, action });
        else success(`${action} sent for ${taskId}`);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });
}
