import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempHome: string;

beforeEach(async () => {
  tempHome = mkdtempSync(join(tmpdir(), "digen-cli-test-"));
  vi.resetModules();
  vi.doMock("node:os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:os")>();
    return { ...actual, homedir: () => tempHome };
  });
});

afterEach(() => {
  vi.doUnmock("node:os");
  rmSync(tempHome, { recursive: true, force: true });
});

describe("config", () => {
  it("returns defaults when no config file exists", async () => {
    const config = await import("../src/lib/config.js");
    expect(config.getApiUrl()).toBe(config.DEFAULT_API_URL);
    expect(config.getLoginUrl()).toBe(config.DEFAULT_LOGIN_URL);
    expect(config.getDefaultWorkflow()).toBe("skill_agent");
    expect(config.getToken()).toBeUndefined();
  });

  it("persists and reloads login details", async () => {
    const config = await import("../src/lib/config.js");
    config.saveLogin({
      token: "tok_abc",
      userId: 7,
      name: "Ada",
      email: "ada@example.com",
      tokenExpiresAt: 1893456000,
    });
    const cfg = config.loadConfig();
    expect(cfg.token).toBe("tok_abc");
    expect(cfg.user_id).toBe(7);
    expect(cfg.name).toBe("Ada");
    expect(config.getUserId()).toBe(7);
    expect(config.getTokenExpiresAt()).toBe(1893456000);
  });

  it("clearLogin removes credential fields but keeps other settings", async () => {
    const config = await import("../src/lib/config.js");
    config.saveConfig({ api_url: "https://custom.example.com" });
    config.saveLogin({ token: "tok_abc", userId: 7 });
    config.clearLogin();
    const cfg = config.loadConfig();
    expect(cfg.token).toBeUndefined();
    expect(cfg.user_id).toBeUndefined();
    expect(cfg.api_url).toBe("https://custom.example.com");
  });

  it("migrates legacy ~/.digen/skill.yaml credentials and keeps a backup", async () => {
    const configDir = join(tempHome, ".digen");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "skill.yaml"),
      [
        "api_url: https://legacy.example.com",
        "login_url: https://legacy-login.example.com",
        "token: legacy-token",
        "user_id: 42",
        "session_id: legacy-session",
        "name: Legacy User",
        "email: legacy@example.com",
        "language: zh",
      ].join("\n"),
    );

    const config = await import("../src/lib/config.js");
    expect(config.getToken()).toBe("legacy-token");
    expect(config.getUserId()).toBe(42);
    expect(config.getApiUrl()).toBe("https://legacy.example.com");
    expect(config.getLanguage()).toBe("zh");
    expect(existsSync(join(configDir, "skill.yaml"))).toBe(false);
    expect(existsSync(join(configDir, "skill.yaml.bak"))).toBe(true);
  });

  it("does not overwrite an existing cli.yaml token during migration", async () => {
    const configDir = join(tempHome, ".digen");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "cli.yaml"), "token: current-token\nuser_id: 1\n");
    writeFileSync(join(configDir, "skill.yaml"), "token: legacy-token\nuser_id: 42\n");

    const config = await import("../src/lib/config.js");
    expect(config.getToken()).toBe("current-token");
    expect(config.getUserId()).toBe(1);
    expect(existsSync(join(configDir, "skill.yaml.bak"))).toBe(true);
  });

  it("ensureSessionId creates and persists a stable id", async () => {
    const config = await import("../src/lib/config.js");
    const first = config.ensureSessionId();
    const second = config.ensureSessionId();
    expect(first).toBe(second);
    expect(config.loadConfig().session_id).toBe(first);
  });
});
