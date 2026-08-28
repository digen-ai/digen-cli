import { describe, expect, it } from "vitest";
import { buildCliLoginUrl, generateState, loopbackCallbackServer } from "../src/lib/auth.js";

describe("buildCliLoginUrl", () => {
  it("builds a /cli/login URL with hint, callback, and state", () => {
    const url = buildCliLoginUrl("https://agent.digen.ai/", {
      hint: "google",
      callback: "http://127.0.0.1:12345/callback",
      state: "abc",
    });
    expect(url).toBe(
      "https://agent.digen.ai/cli/login?hint=google&callback=http%3A%2F%2F127.0.0.1%3A12345%2Fcallback&state=abc",
    );
  });

  it("omits callback/state when not provided", () => {
    const url = buildCliLoginUrl("https://agent.digen.ai", { hint: "google" });
    expect(url).toBe("https://agent.digen.ai/cli/login?hint=google");
  });
});

describe("generateState", () => {
  it("produces distinct, url-safe strings", () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThan(30);
  });
});

describe("TokenCaptureServer (loopback)", () => {
  it("captures a token posted to /callback and resolves waitForResult", async () => {
    const server = await loopbackCallbackServer();
    const state = generateState();
    const url = `http://127.0.0.1:${server.port}/callback`;

    const body = new URLSearchParams({
      token: "tok_e2e:99:1893456000",
      state,
      name: "Ada Lovelace",
      email: "ada@example.com",
      id: "99",
      sessionid: "sess_e2e",
    }).toString();

    const postDone = fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const [result, postResponse] = await Promise.all([server.waitForResult(5000), postDone]);

    expect(postResponse.status).toBe(200);
    expect(result).toEqual({
      token: "tok_e2e:99:1893456000",
      state,
      name: "Ada Lovelace",
      email: "ada@example.com",
      id: "99",
      sessionid: "sess_e2e",
    });
  });

  it("times out with a null result if no callback arrives", async () => {
    const server = await loopbackCallbackServer();
    const result = await server.waitForResult(50);
    expect(result).toBeNull();
  });

  it("rejects a POST /callback with no token", async () => {
    const server = await loopbackCallbackServer();
    const url = `http://127.0.0.1:${server.port}/callback`;
    const resultPromise = server.waitForResult(500);
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "state=abc",
    });
    expect(resp.status).toBe(400);
    expect(await resultPromise).toBeNull();
  });
});
