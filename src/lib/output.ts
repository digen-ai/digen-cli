/** Shared output/error helpers for non-interactive commands. */

import chalk from "chalk";
import type { Command } from "commander";
import { ApiError } from "./errors.js";

export function isJson(program: Command): boolean {
  return Boolean(program.optsWithGlobals().json);
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function handleCommandError(err: unknown): void {
  if (err instanceof ApiError) {
    console.error(chalk.red(err.detail));
  } else {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
  }
  process.exitCode = 1;
}

export function handleJsonError(err: unknown): void {
  const message =
    err instanceof ApiError ? err.detail : err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ error: message }, null, 2));
  process.exitCode = 1;
}

export function fail(message: string): void {
  console.error(chalk.red(message));
  process.exitCode = 1;
}

export function success(message: string): void {
  console.log(chalk.green(`✔ ${message}`));
}

export function parseList(value?: string): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
