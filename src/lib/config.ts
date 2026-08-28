/**
 * CLI configuration management.
 *
 * Stores settings in ~/.digen/cli.yaml. Field names mirror the Python
 * reference client (skills/cli/cli/config.py) so a user's mental model
 * transfers between tools, even though this CLI keeps its own file.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

export const DEFAULT_API_URL = "https://api.digen.ai";
export const DEFAULT_LOGIN_URL = "https://agent.digen.ai";
export const DEFAULT_WORKFLOW = "skill_agent";

export const CONFIG_DIR = join(homedir(), ".digen");
export const CONFIG_FILE = join(CONFIG_DIR, "cli.yaml");
export const HISTORY_FILE = join(CONFIG_DIR, "history");

export interface DigenConfig {
  api_url?: string;
  login_url?: string;
  token?: string;
  user_id?: number;
  session_id?: string;
  token_expires_at?: number;
  name?: string;
  email?: string;
  language?: string;
  default_workflow?: string;
  [key: string]: unknown;
}

function ensureDirs(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): DigenConfig {
  ensureDirs();
  if (!existsSync(CONFIG_FILE)) {
    return {};
  }
  const raw = readFileSync(CONFIG_FILE, "utf-8");
  const parsed = yaml.load(raw);
  return (parsed as DigenConfig) ?? {};
}

export function saveConfig(cfg: DigenConfig): void {
  ensureDirs();
  writeFileSync(CONFIG_FILE, yaml.dump(cfg, { lineWidth: -1 }), "utf-8");
}

export function getApiUrl(): string {
  return loadConfig().api_url ?? DEFAULT_API_URL;
}

export function getLoginUrl(): string {
  return loadConfig().login_url ?? DEFAULT_LOGIN_URL;
}

export function getToken(): string | undefined {
  return loadConfig().token;
}

export function getUserId(): number | undefined {
  const uid = loadConfig().user_id;
  return uid === undefined || uid === null ? undefined : Number(uid);
}

export function getTokenExpiresAt(): number | undefined {
  const raw = loadConfig().token_expires_at;
  return raw === undefined || raw === null ? undefined : Number(raw);
}

export function getLanguage(): string {
  return loadConfig().language ?? "en";
}

export function getDefaultWorkflow(): string {
  return loadConfig().default_workflow ?? DEFAULT_WORKFLOW;
}

export function getSessionId(): string | undefined {
  const sid = loadConfig().session_id;
  return sid ? String(sid) : undefined;
}

/** Return a stable `digen-sessionid`, creating one if login did not supply it. */
export function ensureSessionId(): string {
  const existing = getSessionId();
  if (existing) return existing;
  const sid = randomUUID();
  const cfg = loadConfig();
  cfg.session_id = sid;
  saveConfig(cfg);
  return sid;
}

export interface SaveLoginOptions {
  token: string;
  userId?: number | null;
  name?: string | null;
  email?: string | null;
  language?: string | null;
  sessionId?: string | null;
  tokenExpiresAt?: number | null;
}

/** Persist a successful login response into the config file. */
export function saveLogin(opts: SaveLoginOptions): void {
  const cfg = loadConfig();
  cfg.token = opts.token;
  cfg.session_id = opts.sessionId || cfg.session_id || randomUUID();
  if (opts.userId !== undefined && opts.userId !== null) cfg.user_id = opts.userId;
  if (opts.name) cfg.name = opts.name;
  if (opts.email) cfg.email = opts.email;
  if (opts.language) cfg.language = opts.language;
  if (opts.tokenExpiresAt !== undefined && opts.tokenExpiresAt !== null) {
    cfg.token_expires_at = opts.tokenExpiresAt;
  }
  saveConfig(cfg);
}

export function clearLogin(): void {
  const cfg = loadConfig();
  for (const key of [
    "token",
    "user_id",
    "name",
    "email",
    "language",
    "session_id",
    "token_expires_at",
  ]) {
    delete cfg[key];
  }
  saveConfig(cfg);
}
