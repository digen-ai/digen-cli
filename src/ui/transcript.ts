/**
 * Turns the Digen SSE chat event stream into a structured, renderer-agnostic
 * transcript: an ordered list of lines grouped by turn.
 *
 * This is the shared "model" behind both UIs:
 *  - the mouse-driven Ink TUI (`ui/tui/`), which renders lines live and lets
 *    you hover an asset line to preview it;
 *  - nothing else needs it — the non-TTY fallback (`ui/render.ts`) keeps
 *    writing straight to stdout, since there's no interactivity to support
 *    there.
 *
 * Unlike the old `ChatRenderer`, asset resolution (presigning a URL) happens
 * as soon as the event arrives and updates its line in place — there's no
 * need to batch until the turn ends, since the UI re-renders declaratively
 * instead of writing bytes to a stream that could get interleaved.
 */

import { isInlineImage, pickUrl } from "../lib/assets.js";
import type { DigenClient } from "../lib/client.js";
import type { ChatEvent } from "../lib/sse.js";

export type TurnOutcome =
  | { kind: "continue" }
  | { kind: "done" }
  | { kind: "error"; message: string }
  | { kind: "await_confirmation"; confirmationType?: string; message?: string };

export type AssetStatus = "pending" | "resolved" | "error";

export interface AssetLineData {
  assetType: string;
  name: string;
  /** `placeholder` assets are still generating; nothing to resolve yet. */
  placeholder: boolean;
  status: AssetStatus;
  /** Link to show/open once resolved (may still be a non-fetchable `s3://` uri). */
  url?: string;
  /** Best URL to download bytes from for a hover preview (image, or video with a thumbnail). */
  thumbUrl?: string;
  assetId?: string;
  providers: string[];
  thumbProviders?: string[];
}

export type StatusTone = "info" | "success" | "error" | "warn" | "dim";

export type TranscriptLine =
  | { id: string; turn: number; kind: "user"; text: string }
  | { id: string; turn: number; kind: "agentHeader"; agent: string }
  | { id: string; turn: number; kind: "text"; agent: string; content: string }
  | { id: string; turn: number; kind: "thinking"; content: string; done: boolean }
  | {
      id: string;
      turn: number;
      kind: "tool";
      name: string;
      status: "running" | "success" | "error";
    }
  | { id: string; turn: number; kind: "asset"; data: AssetLineData }
  | { id: string; turn: number; kind: "guidanceHeader" }
  | { id: string; turn: number; kind: "guidanceItem"; text: string }
  | { id: string; turn: number; kind: "status"; text: string; tone: StatusTone };

/** Plain `Omit` collapses a union to its common keys; this preserves each member's own shape. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type NewLine = DistributiveOmit<TranscriptLine, "id" | "turn">;

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

/** Assets whose thumbnail is worth fetching for a hover preview. */
export function isPreviewable(data: AssetLineData): boolean {
  if (data.status !== "resolved" || !data.thumbUrl) return false;
  return isInlineImage(data.assetType) || data.assetType === "video";
}

export interface TranscriptOptions {
  /** Client used to resolve `asset_id` -> presigned URL. Omit to disable resolution entirely. */
  client?: DigenClient;
  /** Set to "off" to skip presigning and just show whatever raw link the event carried. */
  images?: "auto" | "off";
}

interface PendingAssetInfo {
  assetType: string;
  assetId?: string;
  providers: string[];
  thumbProviders?: string[];
  directUrl?: string;
  fallbackUri: string;
}

export class TranscriptStore {
  private lines: TranscriptLine[] = [];
  private listeners = new Set<() => void>();
  private client?: DigenClient;
  private imagesEnabled: boolean;
  private turn = 0;
  private seq = 0;
  private currentTextAgent: string | null = null;
  private currentTextLineId: string | null = null;
  private currentThinkingLineId: string | null = null;

  constructor(opts?: TranscriptOptions) {
    this.client = opts?.client;
    this.imagesEnabled = (opts?.images ?? "auto") !== "off";
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Stable-until-mutated snapshot for `useSyncExternalStore`. */
  getLines = (): TranscriptLine[] => this.lines;

  getCurrentTurn(): number {
    return this.turn;
  }

  /** Begin a new turn: freezes all prior lines and records the user's message. */
  startTurn(userText: string): void {
    this.turn += 1;
    this.currentTextAgent = null;
    this.currentTextLineId = null;
    this.currentThinkingLineId = null;
    this.pushLine({ kind: "user", text: userText });
  }

  /** Feed one SSE event; returns a signal telling the caller what to do next. */
  handle(event: ChatEvent): TurnOutcome {
    switch (event.type) {
      case "start":
        return { kind: "continue" };

      case "chunk": {
        const content = event.content ?? "";
        if (!content) return { kind: "continue" };
        const agent = event.agent ?? "assistant";
        if (agent !== this.currentTextAgent) {
          this.currentTextAgent = agent;
          this.pushLine({ kind: "agentHeader", agent });
          const line = this.pushLine({ kind: "text", agent, content: "" });
          this.currentTextLineId = line.id;
        }
        if (this.currentTextLineId) {
          const lineId = this.currentTextLineId;
          this.updateLine(lineId, (l) =>
            l.kind === "text" ? { ...l, content: l.content + content } : l,
          );
        }
        return { kind: "continue" };
      }

      case "thinking": {
        if (event.phase === "start") {
          const line = this.pushLine({ kind: "thinking", content: "", done: false });
          this.currentThinkingLineId = line.id;
        } else if (event.phase === "end") {
          if (this.currentThinkingLineId) {
            const lineId = this.currentThinkingLineId;
            this.updateLine(lineId, (l) => (l.kind === "thinking" ? { ...l, done: true } : l));
          }
          this.currentThinkingLineId = null;
        } else if (event.content && this.currentThinkingLineId) {
          const lineId = this.currentThinkingLineId;
          const chunk = event.content;
          this.updateLine(lineId, (l) =>
            l.kind === "thinking" ? { ...l, content: l.content + chunk } : l,
          );
        }
        return { kind: "continue" };
      }

      case "agent": {
        const label = event.agent ?? "agent";
        if (event.phase === "start") {
          const task = (event.data?.task_description as string | undefined) ?? "";
          this.pushLine({
            kind: "status",
            text: `▶ ${label}${task ? ` — ${task}` : ""}`,
            tone: "info",
          });
          this.currentTextAgent = null;
        } else if (event.phase === "end") {
          this.pushLine({ kind: "status", text: `◀ ${label} done`, tone: "dim" });
        }
        return { kind: "continue" };
      }

      case "tool": {
        const name = event.tool ?? "tool";
        if (event.phase === "start") {
          this.pushLine({ kind: "tool", name, status: "running" });
        } else if (event.phase === "end") {
          const ok = event.status !== "error";
          const existing = [...this.lines]
            .reverse()
            .find((l) => l.kind === "tool" && l.name === name && l.status === "running");
          if (existing) {
            const id = existing.id;
            this.updateLine(id, (l) =>
              l.kind === "tool" ? { ...l, status: ok ? "success" : "error" } : l,
            );
          } else {
            this.pushLine({ kind: "tool", name, status: ok ? "success" : "error" });
          }
        }
        return { kind: "continue" };
      }

      case "asset": {
        const data = event.data ?? {};
        const assetType = (data.type as string | undefined) ?? "asset";
        const name = (data.name as string | undefined) ?? "";

        if (event.phase === "placeholder") {
          this.pushLine({
            kind: "asset",
            data: {
              assetType,
              name,
              placeholder: true,
              status: "pending",
              providers: [],
            },
          });
          return { kind: "continue" };
        }

        const directUrl = data.url as string | undefined;
        const fallbackUri = (data.uri as string | undefined) ?? "";
        const assetId = data.asset_id as string | undefined;
        const providers = (data.providers as string[] | undefined) ?? [];
        const thumbProviders = data.thumb_providers as string[] | undefined;

        const line = this.pushLine({
          kind: "asset",
          data: {
            assetType,
            name,
            placeholder: false,
            status: "pending",
            url: directUrl,
            providers,
            thumbProviders,
          },
        });

        void this.resolveAsset(line.id, {
          assetType,
          assetId,
          providers,
          thumbProviders,
          directUrl,
          fallbackUri,
        });
        return { kind: "continue" };
      }

      case "guidance": {
        const raw = event.data?.suggested_questions;
        const suggestions = Array.isArray(raw)
          ? raw.map(suggestionLabel).filter((s): s is string => s !== null)
          : [];
        if (suggestions.length > 0) {
          this.pushLine({ kind: "guidanceHeader" });
          for (const text of suggestions) this.pushLine({ kind: "guidanceItem", text });
        }
        return { kind: "continue" };
      }

      case "await_confirmation": {
        const confirmationType = event.data?.confirmation_type as string | undefined;
        this.pushLine({
          kind: "status",
          text: `⏸ Waiting for confirmation${confirmationType ? ` (${confirmationType})` : ""}. Type /confirm or /cancel.`,
          tone: "warn",
        });
        return { kind: "await_confirmation", confirmationType };
      }

      case "countdown_tick": {
        const remaining = event.data?.remaining ?? event.content;
        this.pushLine({
          kind: "status",
          text: `Auto-continue in ${remaining}s… (/cancel to stop)`,
          tone: "dim",
        });
        return { kind: "continue" };
      }

      case "countdown_done":
        this.pushLine({ kind: "status", text: "Continuing…", tone: "dim" });
        return { kind: "continue" };

      case "countdown_cancelled":
        this.pushLine({ kind: "status", text: "Cancelled.", tone: "warn" });
        return { kind: "continue" };

      case "error": {
        const message =
          event.content || (event.data?.message as string | undefined) || "Unknown error";
        this.pushLine({ kind: "status", text: `✘ ${message}`, tone: "error" });
        return { kind: "error", message };
      }

      case "done":
        this.currentTextAgent = null;
        return { kind: "done" };

      default:
        if (event.content) {
          this.pushLine({ kind: "status", text: event.content, tone: "dim" });
        }
        return { kind: "continue" };
    }
  }

  private async resolveAsset(lineId: string, info: PendingAssetInfo): Promise<void> {
    if (!this.imagesEnabled) {
      const url = info.directUrl || info.fallbackUri || undefined;
      this.finishAsset(lineId, url ? { status: "resolved", url } : { status: "error" });
      return;
    }

    // A direct image url doubles as its own thumbnail; other types only get a
    // thumbnail if the event explicitly says so (never fetch a whole video as
    // if it were a small preview image).
    const isImage = isInlineImage(info.assetType);

    if (info.directUrl) {
      this.finishAsset(lineId, {
        status: "resolved",
        url: info.directUrl,
        thumbUrl: isImage ? info.directUrl : undefined,
      });
      return;
    }

    if (this.client && info.assetId && info.providers.length > 0) {
      try {
        const presign = await this.client.getPresignedUrls([
          {
            asset_id: info.assetId,
            providers: info.providers,
            thumbnail_providers: info.thumbProviders,
          },
        ]);
        const result = presign.results[0];
        if (!result || result.error) throw new Error(result?.error ?? "presign failed");
        const url = pickUrl(result.urls, info.providers);
        if (!url) throw new Error("no url available");
        const explicitThumb = pickUrl(result.thumbnail_urls, info.thumbProviders);
        const thumbUrl = explicitThumb ?? (isImage ? url : undefined);
        this.finishAsset(lineId, { status: "resolved", url, thumbUrl });
      } catch {
        const url = info.fallbackUri || undefined;
        this.finishAsset(lineId, { status: "error", url });
      }
      return;
    }

    const url = info.directUrl || info.fallbackUri || undefined;
    this.finishAsset(lineId, url ? { status: "resolved", url } : { status: "error" });
  }

  private finishAsset(lineId: string, patch: Partial<AssetLineData>): void {
    this.updateLine(lineId, (l) =>
      l.kind === "asset" ? { ...l, data: { ...l.data, ...patch } } : l,
    );
  }

  private pushLine(partial: NewLine): TranscriptLine {
    const line = { id: `l${this.seq++}`, turn: this.turn, ...partial } as TranscriptLine;
    this.lines = [...this.lines, line];
    this.notify();
    return line;
  }

  private updateLine(id: string, updater: (line: TranscriptLine) => TranscriptLine): void {
    this.lines = this.lines.map((l) => (l.id === id ? updater(l) : l));
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
