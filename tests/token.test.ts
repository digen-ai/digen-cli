import { describe, expect, it } from "vitest";
import { composeDigenToken, parseDigenToken } from "../src/lib/token.js";

describe("parseDigenToken", () => {
  it("splits token:userId:expiry", () => {
    const parsed = parseDigenToken("abc123:42:1893456000");
    expect(parsed).toEqual({ raw: "abc123", userId: 42, expiresAt: 1893456000 });
  });

  it("returns the raw value when the shape does not match", () => {
    const parsed = parseDigenToken("plain-token-value");
    expect(parsed).toEqual({ raw: "plain-token-value", userId: null, expiresAt: null });
  });

  it("handles tokens that themselves contain colons", () => {
    const parsed = parseDigenToken("a:b:c:7:1893456000");
    expect(parsed).toEqual({ raw: "a:b:c", userId: 7, expiresAt: 1893456000 });
  });

  it("does not misparse a token with only two colon-separated parts", () => {
    const parsed = parseDigenToken("42:1893456000");
    expect(parsed).toEqual({ raw: "42:1893456000", userId: null, expiresAt: null });
  });
});

describe("composeDigenToken", () => {
  it("builds token:userId:expiry from explicit values", () => {
    expect(composeDigenToken("abc123", 42, 1893456000)).toBe("abc123:42:1893456000");
  });

  it("falls back to values embedded in the token", () => {
    expect(composeDigenToken("abc123:42:1893456000")).toBe("abc123:42:1893456000");
  });

  it("defaults userId to 0 and expiry to ~30 days out when unknown", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = composeDigenToken("plain-token");
    const [raw, uid, exp] = result.split(":");
    expect(raw).toBe("plain-token");
    expect(uid).toBe("0");
    expect(Number(exp)).toBeGreaterThan(now + 29 * 24 * 3600);
  });
});
