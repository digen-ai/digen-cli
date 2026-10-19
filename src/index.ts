import { Command } from "commander";
import { registerAssetCommands } from "./commands/assets.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerChatCommand } from "./commands/chat.js";
import { registerConfigCommands } from "./commands/config.js";
import { registerSessionCommands } from "./commands/sessions.js";
import { registerSkillCommand } from "./commands/skill.js";
import { registerTaskCommands } from "./commands/tasks.js";
import { registerUploadCommand } from "./commands/upload.js";
import { registerWorkflowsCommand } from "./commands/workflows.js";

const program = new Command();

program
  .name("digen")
  .description("Interactive command-line chat client for the Digen agent API")
  .option("--json", "Print machine-readable JSON output where applicable")
  .version("0.1.0");

registerAuthCommands(program);
registerConfigCommands(program);
registerWorkflowsCommand(program);
registerChatCommand(program);
registerSessionCommands(program);
registerUploadCommand(program);
registerAssetCommands(program);
registerTaskCommands(program);
registerSkillCommand(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
