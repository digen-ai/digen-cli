/**
 * Renders the Digen SSE chat event stream to the terminal.
 *
 * This is the non-interactive fallback used when stdout/stdin aren't a TTY
 * (piped output, `--no-images`/`DIGEN_IMAGES=off`, non-interactive shells):
 * plain sequential writes, no mouse, no inline images — every asset (image
 * included) is just a link. The interactive terminal experience, including
 * hover-to-preview, lives in `ui/tui/` on top of `ui/transcript.ts` instead.
 *
 * Assistant text (`chunk`) is written raw as it streams in, since partial
 * markdown can't be safely re-parsed mid-stream; completed messages (e.g.
 * conversation history) are rendered as full markdown instead (see
 * `renderMarkdown` / `commands/sessions.ts`).
 */

import chalk from "chalk";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { pickUrl } from "../lib/assets.js";
import type { DigenClient } from "../lib/client.js";
import type { ChatEvent } from "../lib/sse.js";

marked.use(
  markedTerminal({
    reflowText: true,
    width: Math.min(process.stdout.columns || 100, 100),
  }) as never,
);

export function renderMarkdown(text: string): string {
  return String(marked.parse(text)).trimEnd();
}

const AGENT_COLORS = [chalk.cyan, chalk.magenta, chalk.green, chalk.yellow, chalk.blue];

function colorForAgent(agent: string): (text: string) => string {
  let hash = 0;
  for (let i = 0; i < agent.length; i++) hash = (hash * 31 + agent.charCodeAt(i)) >>> 0;
  const color = AGENT_COLORS[hash % AGENT_COLORS.length] ?? chalk.white;
  return color;
}

/** `guidance.suggested_questions` items are strings (legacy) or `{ text }` objects. */
function suggestionLabel(item: unknown): string | null {
  if (typeof item === "string") {
    const text = item.trim();
    return text || null;
  }
  if (item && typeof item === "object" && "text" in item) {
    const text = String((item as { text?: unknown }).text ?? "").trim();
    return text || null;
  }
  return null;
}

export type TurnOutcome =
  | { kind: "continue" }
  | { kind: "done" }
  | { kind: "error"; message: string }
  | { kind: "await_confirmation"; confirmationType?: string; message?: string };

export interface ChatRendererOptions {
  /** Client used to resolve `asset_id` -> presigned URL. Omit to disable resolution entirely. */
  client?: DigenClient;
  /** Set to "off" to skip presigning and just print the raw asset link as-is. */
  images?: "auto" | "off";
}

interface PendingAssetInfo {
  assetId?: string;
  providers: string[];
  thumbProviders?: string[];
  /** Already-resolved HTTPS URL, if the event carried one directly (skips presign). */
  directUrl?: string;
  /** s3:// (or other non-fetchable) URI to fall back to when resolution fails. */
  fallbackUri: string;
}

export class ChatRenderer {
  private currentTextAgent: string | null = null;
  private atLineStart = true;
  private thinkingOpen = false;
  private toolStack: string[] = [];
  private client?: DigenClient;
  private imagesEnabled: boolean;
  private pendingAssets: Promise<() => void>[] = [];

  constructor(opts?: ChatRendererOptions) {
    this.client = opts?.client;
    this.imagesEnabled = (opts?.images ?? "auto") !== "off";
  }

  private async prepareAsset(info: PendingAssetInfo): Promise<() => void> {
    try {
      let resolvedUrl = info.directUrl;
      if (!resolvedUrl && this.client && info.assetId && info.providers.length > 0) {
        const presign = await this.client.getPresignedUrls([
          {
            asset_id: info.assetId,
            providers: info.providers,
            thumbnail_providers: info.thumbProviders,
          },
        ]);
        const result = presign.results[0];
        if (!result || result.error) throw new Error(result?.error ?? "presign failed");
        resolvedUrl = pickUrl(result.urls, info.providers);
      }
      if (!resolvedUrl) throw new Error("no url available");

      return () => {
        this.ensureNewline();
        this.write(chalk.dim(`     ${resolvedUrl}\n`));
      };
    } catch {
      const link = info.directUrl || info.fallbackUri;
      return () => {
        if (!link) return;
        this.ensureNewline();
        this.write(chalk.dim(`     ${link}\n`));
      };
    }
  }

  /** Await all pending asset resolutions/downloads and print them in arrival order. */
  async flushAssets(): Promise<void> {
    const pending = this.pendingAssets;
    if (pending.length === 0) return;
    this.pendingAssets = [];
    const thunks = await Promise.all(pending);
    for (const thunk of thunks) thunk();
  }

  private write(text: string): void {
    process.stdout.write(text);
    if (text.length > 0) {
      this.atLineStart = text.endsWith("\n");
    }
  }

  private ensureNewline(): void {
    if (!this.atLineStart) this.write("\n");
  }

  /** Feed one SSE event; returns a signal telling the REPL what to do next. */
  handle(event: ChatEvent): TurnOutcome {
    switch (event.type) {
      case "start":
        return { kind: "continue" };

      case "chunk": {
        const content = event.content ?? "";
        if (!content) return { kind: "continue" };
        const agent = event.agent ?? "assistant";
        if (agent !== this.currentTextAgent) {
          this.ensureNewline();
          if (this.currentTextAgent !== null) this.write("\n");
          const color = colorForAgent(agent);
          this.write(color(chalk.bold(`${agent}\n`)));
          this.currentTextAgent = agent;
        }
        this.write(content);
        return { kind: "continue" };
      }

      case "thinking": {
        if (event.phase === "start") {
          this.ensureNewline();
          this.write(chalk.dim.italic("thinking…\n"));
          this.thinkingOpen = true;
        } else if (event.phase === "end") {
          this.thinkingOpen = false;
          this.ensureNewline();
        } else if (event.content) {
          this.write(chalk.dim.italic(event.content));
        }
        return { kind: "continue" };
      }

      case "agent": {
        this.ensureNewline();
        const label = event.agent ?? "agent";
        if (event.phase === "start") {
          const task = (event.data?.task_description as string | undefined) ?? "";
          const suffix = task ? chalk.dim(` — ${task}`) : "";
          this.write(`${chalk.bold(`\n▶ ${label}`)}${suffix}\n`);
          this.currentTextAgent = null;
        } else if (event.phase === "end") {
          this.write(chalk.dim(`◀ ${label} done\n`));
        }
        return { kind: "continue" };
      }

      case "tool": {
        this.ensureNewline();
        const name = event.tool ?? "tool";
        if (event.phase === "start") {
          this.toolStack.push(name);
          this.write(chalk.dim(`  ⚙ ${name}…\n`));
        } else if (event.phase === "end") {
          this.toolStack = this.toolStack.filter((t) => t !== name);
          const ok = event.status !== "error";
          const icon = ok ? chalk.green("✔") : chalk.red("✘");
          this.write(chalk.dim(`  ${icon} ${name}\n`));
        }
        return { kind: "continue" };
      }

      case "asset": {
        this.ensureNewline();
        const data = event.data ?? {};
        const assetType = (data.type as string | undefined) ?? "asset";
        const name = (data.name as string | undefined) ?? "";

        if (event.phase === "placeholder") {
          this.write(chalk.dim(`  🖼 ${assetType}${name ? `: ${name}` : ""} (generating…)\n`));
          return { kind: "continue" };
        }

        this.write(chalk.blueBright(`  🖼 ${assetType}${name ? `: ${name}` : ""}\n`));

        const directUrl = data.url as string | undefined;
        const fallbackUri = (data.uri as string | undefined) ?? "";
        const assetId = data.asset_id as string | undefined;
        const providers = (data.providers as string[] | undefined) ?? [];
        const thumbProviders = data.thumb_providers as string[] | undefined;
        const canResolve =
          this.imagesEnabled &&
          Boolean(directUrl || (this.client && assetId && providers.length > 0));

        if (canResolve) {
          this.pendingAssets.push(
            this.prepareAsset({ assetId, providers, thumbProviders, directUrl, fallbackUri }),
          );
        } else if (directUrl || fallbackUri) {
          this.write(chalk.dim(`     ${directUrl || fallbackUri}\n`));
        }
        return { kind: "continue" };
      }

      case "guidance": {
        this.ensureNewline();
        const raw = event.data?.suggested_questions;
        const suggestions = Array.isArray(raw)
          ? raw.map(suggestionLabel).filter((s): s is string => s !== null)
          : [];
        if (suggestions.length > 0) {
          this.write(chalk.dim("\nSuggested follow-ups:\n"));
          for (const s of suggestions) this.write(chalk.dim(`  • ${s}\n`));
        }
        return { kind: "continue" };
      }

      case "await_confirmation": {
        this.ensureNewline();
        const confirmationType = event.data?.confirmation_type as string | undefined;
        this.write(
          chalk.yellow(
            `\n⏸ Waiting for confirmation${confirmationType ? ` (${confirmationType})` : ""}. Type /confirm or /cancel.\n`,
          ),
        );
        return { kind: "await_confirmation", confirmationType };
      }

      case "countdown_tick": {
        const remaining = event.data?.remaining ?? event.content;
        this.write(`\r${chalk.dim(`Auto-continue in ${remaining}s… (/cancel to stop)`)}`);
        this.atLineStart = false;
        return { kind: "continue" };
      }

      case "countdown_done":
        this.ensureNewline();
        this.write(chalk.dim("Continuing…\n"));
        return { kind: "continue" };

      case "countdown_cancelled":
        this.ensureNewline();
        this.write(chalk.yellow("Cancelled.\n"));
        return { kind: "continue" };

      case "error": {
        this.ensureNewline();
        const message =
          event.content || (event.data?.message as string | undefined) || "Unknown error";
        this.write(chalk.red(`\n✘ ${message}\n`));
        return { kind: "error", message };
      }

      case "done":
        this.ensureNewline();
        this.currentTextAgent = null;
        return { kind: "done" };

      default:
        if (event.content) {
          this.ensureNewline();
          this.write(event.content);
        }
        return { kind: "continue" };
    }
  }

  /** Force a fresh line before printing REPL chrome (prompts, errors, etc). */
  finishLine(): void {
    this.ensureNewline();
  }
}
