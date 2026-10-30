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
export const SKILLS_API_PATH = "/api/v1/skills";

/**
 * Request-origin values accepted by the API's `Digen-Platform` header
 * (see vid-agent `docs/API_REFERENCE.md`, "来源标识").
 */
export type DigenPlatform = "ios" | "android" | "web" | "cli" | "mcp";

export const DEFAULT_PLATFORM: DigenPlatform = "cli";

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

export interface PresignItem {
  asset_id: string;
  providers: string[];
  thumbnail_providers?: string[];
}

export interface PresignResult {
  asset_id: string;
  urls: Record<string, string>;
  thumbnail_urls: Record<string, string> | null;
  error: string | null;
}

export interface PresignResponse {
  results: PresignResult[];
  expires_at: string;
}

export interface UploadPresignResponse {
  upload_url: string;
  final_url: string;
  key: string;
  max_size: number;
}

export interface UploadedAsset {
  asset_id: string;
  uri: string;
  type: string;
  source: string;
  providers: string[];
  parsing_status?: string | null;
}

export interface DigenClientOptions {
  apiUrl: string;
  token?: string;
  userId?: number;
  sessionId?: string;
  language?: string;
  tokenExpiresAt?: number;
  referer?: string;
  platform?: DigenPlatform;
  fetchImpl?: typeof fetch;
}

export class DigenClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private fetchImpl: typeof fetch;
  private platform: DigenPlatform;

  constructor(opts: DigenClientOptions) {
    this.baseUrl = opts.apiUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.platform = opts.platform ?? DEFAULT_PLATFORM;
    this.headers = {
      Accept: "application/json, text/plain, */*",
      "digen-language": opts.language || "en",
      "Digen-Platform": this.platform,
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

  /** Send a request and parse its JSON body, raising `ApiError` on failure. */
  async requestJson(method: string, path: string, init?: RequestInit): Promise<unknown> {
    const resp = await this.request(method, path, init);
    return this.parseJsonOrThrow(resp);
  }

  /** Send a request whose body is a `FormData` (multipart), without overriding Content-Type. */
  async requestForm(method: string, path: string, form: FormData): Promise<unknown> {
    const resp = await this.request(method, path, { body: form });
    return this.parseJsonOrThrow(resp);
  }

  /** Send a request and return the raw response bytes (e.g. a zip export). */
  async requestRaw(method: string, path: string, init?: RequestInit): Promise<Buffer> {
    const resp = await this.request(method, path, init);
    if (resp.status >= 400) {
      await this.raiseForStatus(resp);
    }
    return Buffer.from(await resp.arrayBuffer());
  }

  private async json(method: string, path: string, init?: RequestInit): Promise<unknown> {
    return this.requestJson(method, path, init);
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
    this.throwIfGatewayEnvelope(resp, payload);
    return payload;
  }

  /**
   * Some gateway failures (including `token invalid`) come back as HTTP 200
   * with `{ errCode, errMsg }` instead of an HTTP error status. Treat a
   * non-zero `errCode` as a failure so callers don't proceed with an empty body.
   */
  private throwIfGatewayEnvelope(resp: Response, payload: unknown): void {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const obj = payload as Record<string, unknown>;
    if (!("errCode" in obj)) return;
    const code = obj.errCode;
    if (code === 0 || code === "0" || code === null || code === undefined) return;
    const msg =
      (typeof obj.errMsg === "string" && obj.errMsg) ||
      (typeof obj.message === "string" && obj.message) ||
      "Request failed";
    const errCode = typeof code === "string" || typeof code === "number" ? code : String(code);
    throw new ApiError(resp.status, msg, { errCode });
  }

  /** SSE endpoints sometimes return the JSON error envelope instead of an event stream. */
  private async eventStreamBody(
    resp: Response,
    emptyDetail: string,
  ): Promise<ReadableStream<Uint8Array>> {
    const contentType = resp.headers.get("content-type") ?? "";
    if (contentType.includes("json")) {
      await this.parseJsonOrThrow(resp);
      throw new ApiError(resp.status, "Expected an event stream");
    }
    if (resp.status >= 400) {
      await this.raiseForStatus(resp);
    }
    if (!resp.body) {
      throw new ApiError(resp.status, emptyDetail);
    }
    return resp.body;
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
    // The API also accepts the origin in `client_env.platform` (older clients
    // and the web UI use it); keep it in sync with the request header so the
    // conversation is attributed even if the header is dropped by a proxy.
    const env = { ...(clientEnv ?? {}), platform: this.platform };
    const data = await this.json(
      "POST",
      `/api/v1/conversations?${new URLSearchParams({ workflow }).toString()}`,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_env: env }),
      },
    );
    return data as ConversationSummary;
  }

  async getConversation(conversationId: string): Promise<Record<string, unknown>> {
    const data = await this.json("GET", `/api/v1/conversations/${conversationId}`);
    return data as Record<string, unknown>;
  }

  async listConversations(
    limit = 50,
    offset = 0,
    opts?: { bookmarkedOnly?: boolean; featuredStatus?: string },
  ): Promise<ConversationSummary[]> {
    const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (opts?.bookmarkedOnly) qs.set("bookmarked_only", "true");
    if (opts?.featuredStatus) qs.set("featured_status", opts.featuredStatus);
    const data = await this.json("GET", `/api/v1/conversations?${qs.toString()}`);
    if (Array.isArray(data)) return data as ConversationSummary[];
    const obj = data as { items?: ConversationSummary[] } | null;
    return obj?.items ?? [];
  }

  async getConversationMessages(
    conversationId: string,
    opts?: { limit?: number; offset?: number; before?: number | string },
  ): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) qs.set("offset", String(opts.offset));
    if (opts?.before !== undefined) qs.set("before", String(opts.before));
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

  async updateConversationWorkflow(conversationId: string, workflow: string): Promise<void> {
    const resp = await this.request("PATCH", `/api/v1/conversations/${conversationId}/workflow`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow }),
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
    const body = await this.eventStreamBody(resp, "Empty response body for chat stream");
    const taskId = resp.headers.get("x-task-id");
    return { taskId, events: parseChatEvents(body) };
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
    const body = await this.eventStreamBody(resp, "Empty response body for resume stream");
    return parseChatEvents(body);
  }

  // ==================== Assets ====================

  async getPresignedUrls(items: PresignItem[]): Promise<PresignResponse> {
    const data = await this.json("POST", "/api/v1/assets/presigned-urls", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    return data as PresignResponse;
  }

  // ==================== Uploads ====================

  /** Step 1: ask the API for a presigned S3 PUT URL for this file. */
  async presignUpload(
    conversationId: string,
    opts: { filename: string; contentType: string; fileSize?: number },
  ): Promise<UploadPresignResponse> {
    const qs = new URLSearchParams({ conversation_id: conversationId });
    const data = await this.json("POST", `/api/v1/upload/presign?${qs.toString()}`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: opts.filename,
        content_type: opts.contentType,
        file_size: opts.fileSize,
      }),
    });
    return data as UploadPresignResponse;
  }

  /**
   * Step 2: PUT the file bytes straight to S3 using the presigned URL. This
   * goes directly to the presigned host, not through the gateway, so it must
   * not carry any `digen-token`/`digen-sessionid` headers — only the two
   * headers that are SigV4-signed into the URL.
   */
  async uploadToPresignedUrl(
    uploadUrl: string,
    body: Buffer,
    contentType: string,
    opts?: { acl?: string | null },
  ): Promise<void> {
    const headers: Record<string, string> = { "Content-Type": contentType };
    const acl = opts?.acl === undefined ? "public-read" : opts.acl;
    if (acl) headers["x-amz-acl"] = acl;
    const resp = await this.fetchImpl(uploadUrl, {
      method: "PUT",
      body,
      headers,
    });
    if (!resp.ok) {
      throw new ApiError(resp.status, `Failed to upload file to storage: HTTP ${resp.status}`);
    }
  }

  /** Step 3: register the uploaded S3 object as an asset on the conversation. */
  async registerUploadedAsset(
    conversationId: string,
    opts: {
      url: string;
      assetType: string;
      contentType?: string;
      filename?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<UploadedAsset> {
    const data = await this.json("POST", `/api/v1/conversations/${conversationId}/assets/upload`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: opts.url,
        asset_type: opts.assetType,
        content_type: opts.contentType,
        filename: opts.filename,
        ...(opts.metadata ? { metadata: opts.metadata } : {}),
      }),
    });
    return data as UploadedAsset;
  }

  async getAssetStatus(conversationId: string, assetId: string): Promise<Record<string, unknown>> {
    const data = await this.json(
      "GET",
      `/api/v1/conversations/${conversationId}/assets/${assetId}/status`,
    );
    return data as Record<string, unknown>;
  }

  // ==================== Tasks ====================

  async getTask(taskId: string): Promise<Record<string, unknown>> {
    const data = await this.json("GET", `/api/v1/tasks/${taskId}`);
    return data as Record<string, unknown>;
  }

  async listActiveTasks(taskType?: string): Promise<Record<string, unknown>[]> {
    const suffix = taskType ? `?task_type=${encodeURIComponent(taskType)}` : "";
    const data = await this.json("GET", `/api/v1/tasks/active${suffix}`);
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
