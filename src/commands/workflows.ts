import chalk from "chalk";
import type { Command } from "commander";
import { ApiError } from "../lib/errors.js";
import { getClient } from "../lib/session.js";

function describeName(desc: unknown): string | null {
  if (!desc) return null;
  if (typeof desc === "string") return desc;
  if (typeof desc === "object") {
    const obj = desc as Record<string, string>;
    return obj.en || obj.default || Object.values(obj)[0] || null;
  }
  return null;
}

export function registerWorkflowsCommand(program: Command): void {
  program
    .command("workflows")
    .description("List available workflows (pick one for `digen chat --workflow`)")
    .action(async () => {
      // Public endpoint; works even before `digen login`.
      const client = getClient();
      try {
        const workflows = await client.listWorkflows();
        if (workflows.length === 0) {
          console.log(chalk.yellow("No workflows available"));
          return;
        }
        for (const wf of workflows) {
          const desc = describeName(wf.description);
          console.log(`${chalk.bold(wf.name)}${wf.display_name ? ` (${wf.display_name})` : ""}`);
          if (desc) console.log(`  ${chalk.dim(desc)}`);
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
}
