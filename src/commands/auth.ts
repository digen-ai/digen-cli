import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import type { Command } from "commander";
import {
  type LoginCallbackResult,
  buildCliLoginUrl,
  generateState,
  loopbackCallbackServer,
  openBrowser,
} from "../lib/auth.js";
import { clearLogin, getLoginUrl, loadConfig, saveLogin } from "../lib/config.js";
import { parseDigenToken } from "../lib/token.js";

async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function saveLoginResult(data: {
  token: string;
  name?: string | null;
  email?: string | null;
  id?: string | null;
  sessionid?: string | null;
}): void {
  if (!data.token) {
    console.error(chalk.red("Login response did not include a token"));
    process.exitCode = 1;
    return;
  }
  const parsed = parseDigenToken(data.token);
  let userId = data.id ? Number.parseInt(data.id, 10) : null;
  if (userId === null || Number.isNaN(userId)) {
    userId = parsed.userId;
  }
  saveLogin({
    token: parsed.raw,
    userId,
    name: data.name,
    email: data.email,
    sessionId: data.sessionid,
    tokenExpiresAt: parsed.expiresAt,
  });
  const who = data.name || data.email || "user";
  console.log(chalk.green(`✔ Logged in as ${who}`));
  if (userId === null) {
    console.log(
      chalk.yellow(
        "Login response did not include a user id. If later API calls fail, contact support.",
      ),
    );
  }
}

function savePastedToken(token: string): void {
  if (!token) {
    console.error(chalk.red("No token provided"));
    process.exitCode = 1;
    return;
  }
  const parsed = parseDigenToken(token);
  saveLogin({ token: parsed.raw, userId: parsed.userId, tokenExpiresAt: parsed.expiresAt });
  console.log(chalk.green("✔ Token saved"));
}

async function browserLogin(opts: { manual: boolean }): Promise<void> {
  const loginBase = getLoginUrl();
  let result: LoginCallbackResult | null = null;
  let urlPrinted = false;

  if (!opts.manual) {
    try {
      const server = await loopbackCallbackServer();
      const state = generateState();
      const callback = `http://127.0.0.1:${server.port}/callback`;
      const url = buildCliLoginUrl(loginBase, { hint: "google", callback, state });
      console.log(chalk.bold("Open this URL if the browser does not open:"));
      console.log(url);
      console.log(chalk.dim("Waiting for authorization…"));
      urlPrinted = true;
      openBrowser(url);
      result = await server.waitForResult();
      if (result?.token) {
        if (result.state !== state) {
          console.error(chalk.red("Login callback state mismatch"));
          process.exitCode = 1;
          return;
        }
        saveLoginResult(result);
        return;
      }
      console.log(chalk.yellow("Did not receive a local callback; paste the token from the page"));
    } catch {
      console.log(
        chalk.yellow("Could not bind a local callback port; paste the token from the page"),
      );
    }
  }

  const url = buildCliLoginUrl(loginBase, { hint: "google" });
  let token: string;
  if (urlPrinted) {
    console.log(
      chalk.dim("Copy the token from the page and paste it here (same as: digen login --token)"),
    );
    token = await promptLine(chalk.yellow("token> "));
  } else {
    console.log(chalk.bold("Open this URL if the browser does not open:"));
    console.log(url);
    console.log(chalk.dim("Copy the token from the page and paste it here"));
    token = await promptLine(chalk.yellow("token> "));
  }
  savePastedToken(token);
}

export function registerAuthCommands(program: Command): void {
  program
    .command("login")
    .description("Log in via Google and save credentials to ~/.digen/cli.yaml")
    .option("--token <token>", "Log in with an existing token (SSH / paste fallback)")
    .option(
      "--manual",
      "Do not start a local callback server; paste the token from the page",
      false,
    )
    .action(async (opts: { token?: string; manual: boolean }) => {
      if (opts.token) {
        savePastedToken(opts.token);
        return;
      }
      await browserLogin({ manual: opts.manual });
    });

  program
    .command("logout")
    .description("Clear locally saved login credentials")
    .action(() => {
      clearLogin();
      console.log(chalk.green("✔ Logged out"));
    });

  program
    .command("whoami")
    .description("Show the current login identity (local cache; no network request)")
    .action(() => {
      const cfg = loadConfig();
      if (!cfg.token && cfg.user_id === undefined) {
        console.log(chalk.yellow("Not logged in"));
        process.exitCode = 1;
        return;
      }
      console.log(`${chalk.bold("Name:")}     ${cfg.name ?? "(unknown)"}`);
      console.log(`${chalk.bold("Email:")}    ${cfg.email ?? "(unknown)"}`);
      console.log(`${chalk.bold("User ID:")}  ${cfg.user_id ?? "(unknown)"}`);
    });
}
