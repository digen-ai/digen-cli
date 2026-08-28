import chalk from "chalk";
import type { Command } from "commander";
import { GATEWAY_PREFIX } from "../lib/client.js";
import {
  CONFIG_FILE,
  DEFAULT_API_URL,
  DEFAULT_LOGIN_URL,
  DEFAULT_WORKFLOW,
  loadConfig,
  saveConfig,
} from "../lib/config.js";

function maskSecret(value: string | undefined, visible = 8): string {
  if (!value) return "(not set)";
  return value.length > visible ? `${value.slice(0, visible)}...` : value;
}

export function registerConfigCommands(program: Command): void {
  const config = program
    .command("config")
    .description("CLI config (API URL / login URL / workflow)");

  config
    .command("set-api")
    .description(`Set the API base URL (default ${DEFAULT_API_URL})`)
    .argument("<url>", "API base URL")
    .action((url: string) => {
      const cfg = loadConfig();
      cfg.api_url = url;
      saveConfig(cfg);
      console.log(chalk.green(`✔ API URL set to ${url}`));
    });

  config
    .command("set-login-url")
    .description(`Set the web login page base URL (default ${DEFAULT_LOGIN_URL})`)
    .argument("<url>", "Login page base URL")
    .action((url: string) => {
      const cfg = loadConfig();
      cfg.login_url = url;
      saveConfig(cfg);
      console.log(chalk.green(`✔ Login URL set to ${url}`));
    });

  config
    .command("set-workflow")
    .description(`Set the default workflow used by \`digen chat\` (default ${DEFAULT_WORKFLOW})`)
    .argument("<name>", "Workflow name")
    .action((name: string) => {
      const cfg = loadConfig();
      cfg.default_workflow = name;
      saveConfig(cfg);
      console.log(chalk.green(`✔ Default workflow set to ${name}`));
    });

  config
    .command("show")
    .description("Show the current config")
    .action(() => {
      const cfg = loadConfig();
      const apiUrl = (cfg.api_url ?? DEFAULT_API_URL).replace(/\/+$/, "");
      console.log(`API URL:          ${chalk.cyan(apiUrl)}`);
      console.log(`Login URL:        ${chalk.cyan(cfg.login_url ?? DEFAULT_LOGIN_URL)}`);
      console.log(`Chat API:         ${chalk.cyan(apiUrl + GATEWAY_PREFIX)}`);
      console.log(`Default workflow: ${chalk.cyan(cfg.default_workflow ?? DEFAULT_WORKFLOW)}`);
      console.log(`Token:            ${chalk.dim(maskSecret(cfg.token))}`);
      console.log(`Session:          ${chalk.dim(maskSecret(cfg.session_id))}`);
      console.log(`User ID:          ${chalk.dim(String(cfg.user_id ?? "(not set)"))}`);
      console.log(`Language:         ${chalk.dim(cfg.language ?? "en")}`);
      console.log(`Name:             ${chalk.dim(cfg.name ?? "(not set)")}`);
      console.log(`Email:            ${chalk.dim(cfg.email ?? "(not set)")}`);
      console.log(`Config file:      ${chalk.dim(CONFIG_FILE)}`);
    });
}
