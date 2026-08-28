/**
 * HTTP client for the Digen chat API, accessed through the production
 * gateway (`/v2/gateway/agent`). The gateway forwards the upstream body
 * as-is and converts the `digen-token` header into the internal user
 * identity; there is no `X-User-Id` header on the client side.
 *
 * See vid-agent `docs/API_REFERENCE.md` for the full protocol (sections
 * 1-3: conversations/chat/tasks, section 9: SSE event protocol).
 */

import { ApiError, type StructuredErrorDetail } from "./errors.js";
import { type ChatEvent, parseChatEvents } from "./sse.js";
import { composeDigenToken } from "./token.js";

export const GATEWAY_PREFIX = "/v2/gateway/agent";

export type BlockType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "library_item"
  | "skill";

export interface ChatBlock {
  type: BlockType;
  content?: string;
  [key: string]: unknown;
}

export interface ConversationSummary {
  conversation_id: string;
  workflow: string;
  status?: string;
  name?: string | null;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface WorkflowInfo {
  name: string;
  display_name?: string | null;
  description?: unknown;
  type?: string;
  status?: string;
}

export interface ChatStreamResult {
  taskId: string | null;
  events: AsyncGenerator<ChatEvent>;
}

export interface DigenClientOptions {
  apiUrl: string;
  token?: string;
  userId?: number;
  sessionId?: string;
  language?: string;
  tokenExpiresAt?: number;
  referer?: string;
  fetchImpl?: typeof fetch;
}

export class DigenClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private fetchImpl: typeof fetch;

  constructor(opts: DigenClientOptions) {
    this.baseUrl = opts.apiUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.headers = {
      Accept: "application/json, text/plain, */*",
      "digen-language": opts.language || "en",
    };
    if (opts.token) {
      this.headers["digen-token"] = composeDigenToken(opts.token, opts.userId, opts.tokenExpiresAt);
    }
    if (opts.sessionId) {
      this.headers["digen-sessionid"] = opts.sessionId;
    }
    if (opts.referer) {
      this.headers.Referer = `${opts.referer.replace(/\/+$/, "")}/`;
    }
  }

  private url(path: string): string {
    return `${this.baseUrl}${GATEWAY_PREFIX}${path}`;
  }

  private async request(method: string, path: string, init?: RequestInit): Promise<Response> {
    return this.fetchImpl(this.url(path), {
      ...init,
      method,
      headers: { ...this.headers, ...(init?.headers as Record<string, string> | undefined) },
    });
  }

  private async json(method: string, path: string, init?: RequestInit): Promise<unknown> {
    const resp = await this.request(method, path, init);
    return this.parseJsonOrThrow(resp);
  }

  private async parseJsonOrThrow(resp: Response): Promise<unknown> {
    if (resp.status === 204 || resp.headers.get("content-length") === "0") {
      await this.raiseForStatus(resp);
      return null;
    }
    const text = await resp.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      await this.raiseForStatus(resp, text);
      return null;
    }
    if (resp.status >= 400) {
      await this.raiseForStatus(resp, text, payload);
    }
    return payload;
  }

  private async raiseForStatus(
    resp: Response,
    bodyText?: string,
    payload?: unknown,
  ): Promise<void> {
    if (resp.status < 400) return;
    let detail = bodyText ?? (await resp.text().catch(() => ""));
    let structured: StructuredErrorDetail | undefined;
    let errCode: string | number | undefined;
    let parsed = payload;
    if (parsed === undefined) {
      try {
        parsed = detail ? JSON.parse(detail) : undefined;
      } catch {
        parsed = undefined;
      }
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const message = obj.message;
      if (message && typeof message === "object") {
        structured = message as StructuredErrorDetail;
        detail = structured.message ?? String(detail);
        errCode = structured.code;
      } else {
        detail =
          (obj.detail as string | undefined) ||
          (message as string | undefined) ||
          (obj.errMsg as string | undefined) ||
          detail;
        errCode = (obj.errCode as string | number | undefined) ?? errCode;
      }
    }
    throw new ApiError(resp.status, String(detail), { errCode, structured });
  }

  // ==================== Workflows ====================

  async listWorkflows(): Promise<WorkflowInfo[]> {
    const data = await this.json("GET", "/public/v1/workflows");
    return (data as WorkflowInfo[]) ?? [];
  }

  // ==================== Conversations ====================

  async createConversation(
    workflow: string,
    clientEnv?: Record<string, unknown>,
  ): Promise<ConversationSummary> {
    const data = await this.json(
      "POST",
      `/api/v1/conversations?${new URLSearchParams({ workflow }).toString()}`,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(clientEnv ? { client_env: clientEnv } : {}),
      },
    );
    return data as ConversationSummary;
  }

  async getConversation(conversationId: string): Promise<Record<string, unknown>> {
    const data = await this.json("GET", `/api/v1/conversations/${conversationId}`);
    return data as Record<string, unknown>;
  }

  async listConversations(limit = 50, offset = 0): Promise<ConversationSummary[]> {
    const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    const data = await this.json("GET", `/api/v1/conversations?${qs.toString()}`);
    if (Array.isArray(data)) return data as ConversationSummary[];
    const obj = data as { items?: ConversationSummary[] } | null;
    return obj?.items ?? [];
  }

  async getConversationMessages(
    conversationId: string,
    opts?: { limit?: number; before?: string },
  ): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.before) qs.set("before", opts.before);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const data = await this.json(
      "GET",
      `/api/v1/conversations/${conversationId}/messages${suffix}`,
    );
    return data as Record<string, unknown>;
  }

  async deleteConversation(conversationId: string): Promise<void> {
    const resp = await this.request("DELETE", `/api/v1/conversations/${conversationId}`);
    await this.raiseForStatus(resp);
  }

  async renameConversation(conversationId: string, name: string): Promise<void> {
    const resp = await this.request("PATCH", `/api/v1/conversations/${conversationId}/name`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    await this.raiseForStatus(resp);
  }

  // ==================== Chat (SSE) ====================

  async chatStream(opts: {
    blocks: ChatBlock[];
    conversationId: string;
    workflow: string;
    signal?: AbortSignal;
  }): Promise<ChatStreamResult> {
    const resp = await this.request("POST", "/api/v1/chat", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        blocks: opts.blocks,
        conversation_id: opts.conversationId,
        workflow: opts.workflow,
      }),
      signal: opts.signal,
    });
    if (resp.status >= 400) {
      await this.raiseForStatus(resp);
    }
    if (!resp.body) {
      throw new ApiError(resp.status, "Empty response body for chat stream");
    }
    const taskId = resp.headers.get("x-task-id");
    return { taskId, events: parseChatEvents(resp.body) };
  }

  async resumeStream(
    taskId: string,
    afterSequence = 0,
    signal?: AbortSignal,
  ): Promise<AsyncGenerator<ChatEvent>> {
    const qs = new URLSearchParams({ after_sequence: String(afterSequence) });
    const resp = await this.request("GET", `/api/v1/chat/resume/${taskId}?${qs.toString()}`, {
      signal,
    });
    if (resp.status >= 400) {
      await this.raiseForStatus(resp);
    }
    if (!resp.body) {
      throw new ApiError(resp.status, "Empty response body for resume stream");
    }
    return parseChatEvents(resp.body);
  }

  // ==================== Tasks ====================

  async getTask(taskId: string): Promise<Record<string, unknown>> {
    const data = await this.json("GET", `/api/v1/tasks/${taskId}`);
    return data as Record<string, unknown>;
  }

  async listActiveTasks(): Promise<Record<string, unknown>[]> {
    const data = await this.json("GET", "/api/v1/tasks/active");
    return (data as Record<string, unknown>[]) ?? [];
  }

  async cancelTask(taskId: string): Promise<void> {
    const resp = await this.request("DELETE", `/api/v1/tasks/${taskId}`);
    await this.raiseForStatus(resp);
  }

  async confirmCountdown(taskId: string, action: "confirm" | "cancel"): Promise<void> {
    const resp = await this.request("POST", `/api/v1/tasks/${taskId}/countdown`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    await this.raiseForStatus(resp);
  }
}
