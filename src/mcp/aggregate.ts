/**
 * Pure aggregator for the Digen SSE chat event stream, used by the MCP
 * server to turn a stream of `ChatEvent`s into a single structured result
 * that a `digen_poll` tool call can return as JSON.
 *
 * This mirrors the event handling in `ui/render.ts`'s `ChatRenderer`, but
 * has no side effects (no terminal writes, no network calls) so it can run
 * inside a long-lived MCP server process and be polled at any point.
 */

import type { ChatEvent } from "../lib/sse.js";

export type TurnStatus = "running" | "done" | "error" | "await_confirmation" | "cancelled";

export interface AggregatedAsset {
  type: string;
  name: string;
  /** Direct URL from the event, if present; otherwise the raw uri (e.g. `s3://...`). */
  url?: string;
  uri?: string;
  assetId?: string;
  providers: string[];
}

export interface AggregatedTurn {
  status: TurnStatus;
  text: string;
  assets: AggregatedAsset[];
  errorMessage?: string;
  confirmationType?: string;
  suggestedQuestions: string[];
  lastSequence: number;
}

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

/**
 * Accumulates `ChatEvent`s into a single `AggregatedTurn`. Safe to feed
 * events into incrementally (e.g. as they arrive from a background SSE
 * consumer) and read `result()` at any time, including mid-stream.
 */
export class TurnAggregator {
  private textParts: string[] = [];
  private currentAgent: string | null = null;
  private assets: AggregatedAsset[] = [];
  private status: TurnStatus = "running";
  private errorMessage?: string;
  private confirmationType?: string;
  private suggestedQuestions: string[] = [];
  private lastSequence = 0;

  /**
   * Events that signal the stream is actively progressing again after a
   * pause (`await_confirmation`/`cancelled`), e.g. once the countdown
   * resolves and the underlying task resumes producing output.
   */
  private resumeIfPaused(): void {
    if (this.status === "await_confirmation" || this.status === "cancelled") {
      this.status = "running";
      this.confirmationType = undefined;
    }
  }

  handle(event: ChatEvent): void {
    if (typeof event.sequence === "number") this.lastSequence = event.sequence;

    switch (event.type) {
      case "chunk": {
        const content = event.content ?? "";
        if (!content) return;
        this.resumeIfPaused();
        const agent = event.agent ?? "assistant";
        if (agent !== this.currentAgent) {
          if (this.currentAgent !== null) this.textParts.push("\n\n");
          this.currentAgent = agent;
        }
        this.textParts.push(content);
        return;
      }

      case "agent":
      case "tool":
        this.resumeIfPaused();
        return;

      case "countdown_done":
        this.resumeIfPaused();
        return;

      case "asset": {
        if (event.phase === "placeholder") return;
        this.resumeIfPaused();
        const data = event.data ?? {};
        this.assets.push({
          type: (data.type as string | undefined) ?? "asset",
          name: (data.name as string | undefined) ?? "",
          url: data.url as string | undefined,
          uri: data.uri as string | undefined,
          assetId: data.asset_id as string | undefined,
          providers: (data.providers as string[] | undefined) ?? [],
        });
        return;
      }

      case "guidance": {
        const raw = event.data?.suggested_questions;
        if (Array.isArray(raw)) {
          this.suggestedQuestions = raw.map(suggestionLabel).filter((s): s is string => s !== null);
        }
        return;
      }

      case "await_confirmation": {
        this.status = "await_confirmation";
        this.confirmationType = event.data?.confirmation_type as string | undefined;
        return;
      }

      case "countdown_cancelled":
        this.status = "cancelled";
        return;

      case "error": {
        this.status = "error";
        this.errorMessage =
          event.content || (event.data?.message as string | undefined) || "Unknown error";
        return;
      }

      case "done":
        if (this.status !== "error") this.status = "done";
        return;

      default:
        return;
    }
  }

  /**
   * If the SSE stream closed without an explicit terminal event, treat the
   * turn as finished. No-op when already in a terminal or paused state
   * (`done`/`error`/`await_confirmation`/`cancelled`).
   */
  completeIfRunning(): void {
    if (this.status === "running") this.status = "done";
  }

  result(): AggregatedTurn {
    return {
      status: this.status,
      text: this.textParts.join(""),
      assets: this.assets,
      errorMessage: this.errorMessage,
      confirmationType: this.confirmationType,
      suggestedQuestions: this.suggestedQuestions,
      lastSequence: this.lastSequence,
    };
  }
}
