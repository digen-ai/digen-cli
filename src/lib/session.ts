/**
 * Shared helpers for turning stored config into a ready `DigenClient`,
 * and for gating commands that require a prior `digen login`.
 */

import chalk from "chalk";
import { DigenClient } from "./client.js";
import {
  ensureSessionId,
  getApiUrl,
  getLanguage,
  getLoginUrl,
  getToken,
  getTokenExpiresAt,
  getUserId,
  loadConfig,
} from "./config.js";
import { SkillsApi } from "./skillsApi.js";

export function getSkillsApi(): SkillsApi {
  return new SkillsApi(getClient());
}

export function getClient(): DigenClient {
  return new DigenClient({
    apiUrl: getApiUrl(),
    token: getToken(),
    userId: getUserId(),
    sessionId: ensureSessionId(),
    language: getLanguage(),
    tokenExpiresAt: getTokenExpiresAt(),
    referer: getLoginUrl(),
  });
}

/** Returns false (and prints guidance) if the user has not logged in. */
export function requireLogin(): boolean {
  const cfg = loadConfig();
  if (!cfg.token && cfg.user_id === undefined) {
    console.error(chalk.red("Not logged in. Run: digen login"));
    process.exitCode = 1;
    return false;
  }
  return true;
}
