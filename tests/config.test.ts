import { mkdtempSync, rmSync } from "node:fs";
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

  it("ensureSessionId creates and persists a stable id", async () => {
    const config = await import("../src/lib/config.js");
    const first = config.ensureSessionId();
    const second = config.ensureSessionId();
    expect(first).toBe(second);
    expect(config.loadConfig().session_id).toBe(first);
  });
});
