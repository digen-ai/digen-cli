/**
 * Loopback helpers for Google login.
 *
 * The web page at `{loginBase}/cli/login` exchanges Google credentials for a
 * Digen token, then POSTs it to a local callback server. This CLI does not
 * call Google's exchange itself. Email/password and Apple login are not
 * supported.
 *
 * Ported from the Python reference (skills/cli/cli/auth.py):
 * - loopback: listen on 127.0.0.1, receive POST /callback with token + state
 * - manual: print the login URL and let the user paste the Digen token
 */

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import open from "open";

export const LOOPBACK_TIMEOUT_MS = 180_000;

const CALLBACK_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Digen CLI</title></head>
<body style="font-family: sans-serif; text-align: center; margin-top: 10vh;">
<h2>Login complete. You can close this page and return to the terminal.</h2>
</body></html>
`;

export interface LoginCallbackResult {
  token: string;
  state: string | null;
  name: string | null;
  email: string | null;
  id: string | null;
  sessionid: string | null;
}

/** 32 bytes of url-safe random data, used as a CSRF check on the callback. */
export function generateState(): string {
  return randomBytes(32).toString("base64url");
}

export interface BuildLoginUrlOptions {
  hint: string;
  callback?: string;
  state?: string;
}

/** Build `{loginBase}/cli/login?...` for the dedicated web login page. */
export function buildCliLoginUrl(loginBase: string, opts: BuildLoginUrlOptions): string {
  const base = `${loginBase.replace(/\/+$/, "")}/cli/login`;
  const params = new URLSearchParams({ hint: opts.hint });
  if (opts.callback) params.set("callback", opts.callback);
  if (opts.state) params.set("state", opts.state);
  return `${base}?${params.toString()}`;
}

/** Single-shot HTTP server that accepts POST /callback with a Digen token. */
export class TokenCaptureServer {
  private server: Server;
  private resultResolve!: (value: LoginCallbackResult | null) => void;
  private resultPromise: Promise<LoginCallbackResult | null>;
  private settled = false;
  port = 0;

  constructor() {
    this.resultPromise = new Promise((resolve) => {
      this.resultResolve = resolve;
    });
    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  async listen(port = 0): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        const addr = this.server.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        resolve();
      });
    });
    return this;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "POST" || !req.url?.startsWith("/callback")) {
      res.writeHead(req.method === "POST" ? 404 : 405);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      const qs = new URLSearchParams(raw);
      const token = qs.get("token");
      if (!token) {
        res.writeHead(400);
        res.end();
        return;
      }
      const result: LoginCallbackResult = {
        token,
        state: qs.get("state"),
        name: qs.get("name"),
        email: qs.get("email"),
        id: qs.get("id"),
        sessionid: qs.get("sessionid") || qs.get("sessionId"),
      };
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(CALLBACK_HTML);
      if (!this.settled) {
        this.settled = true;
        this.resultResolve(result);
      }
    });
  }

  async waitForResult(timeoutMs = LOOPBACK_TIMEOUT_MS): Promise<LoginCallbackResult | null> {
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => {
        if (!this.settled) {
          this.settled = true;
          this.resultResolve(null);
        }
        resolve(null);
      }, timeoutMs);
    });
    const result = await Promise.race([this.resultPromise, timeout]);
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    return result;
  }
}

export async function loopbackCallbackServer(port = 0): Promise<TokenCaptureServer> {
  const server = new TokenCaptureServer();
  await server.listen(port);
  return server;
}

export function openBrowser(url: string): void {
  void open(url).catch(() => {
    /* best-effort; the CLI also prints the URL for manual opening */
  });
}
