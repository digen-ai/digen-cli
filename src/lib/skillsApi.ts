/**
 * Typed client for the authenticated user skills API
 * (`/api/v1/skills/*`, plus `/api/v1/creator/*`).
 *
 * Shapes follow vid-agent docs/API_REFERENCE.md sections 15.1-15.20. The
 * transport (token/session headers, gateway prefix, error parsing) is shared
 * with `DigenClient`.
 */

import type { DigenClient } from "./client.js";

export interface SkillListResponse {
  builtin?: unknown[];
  space?: unknown[];
  max_mounted?: number;
  space_total?: number;
  [key: string]: unknown;
}

export interface SkillMarketParams {
  tab?: string;
  category?: string;
  q?: string;
  sort?: string;
  limit?: number;
  offset?: number;
  locale?: string;
}

export interface UploadFile {
  bytes: Buffer;
  filename: string;
  contentType: string;
}

export interface SkillCreatePayload {
  display_name: string;
  description?: string;
  body?: string;
  allowed_tools?: string[];
  visibility?: "private" | "public";
  locales?: string[];
  [key: string]: unknown;
}

export interface SkillUpdatePayload {
  display_name?: string;
  description?: string;
  body?: string;
  allowed_tools?: string[];
  reference_files?: Record<string, string>;
  visibility?: "private" | "public";
  enabled?: boolean;
  [key: string]: unknown;
}

export interface SkillListingPayload {
  slug?: string;
  primary_category?: string;
  listing?: Record<string, unknown>;
  locales?: string[];
  [key: string]: unknown;
}

export interface CreatorStatsParams {
  period?: string;
  from?: string;
  to?: string;
}

function jsonInit(body: unknown): RequestInit {
  return {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function zipForm(zip: Buffer, opts?: { visibility?: string; locales?: string[] }): FormData {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(zip)], { type: "application/zip" }), "skill.zip");
  if (opts?.visibility) form.append("visibility", opts.visibility);
  if (opts?.locales && opts.locales.length > 0) {
    form.append("locales", JSON.stringify(opts.locales));
  }
  return form;
}

function fileForm(
  file: UploadFile,
  fields: Record<string, string | boolean | undefined>,
): FormData {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(file.bytes)], { type: file.contentType }),
    file.filename,
  );
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    form.append(key, String(value));
  }
  return form;
}

export class SkillsApi {
  constructor(private client: DigenClient) {}

  private path(...parts: Array<string | number>): string {
    const suffix = parts.map(String).join("/");
    return `/api/v1/skills${suffix ? `/${suffix}` : ""}`;
  }

  // ==================== Space / CRUD ====================

  async list(): Promise<SkillListResponse> {
    return (await this.client.requestJson("GET", this.path())) as SkillListResponse;
  }

  async get(
    skillId: number | string,
    opts?: { overlayDraft?: boolean },
  ): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams();
    if (opts?.overlayDraft === false) qs.set("overlay_draft", "false");
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return (await this.client.requestJson("GET", `${this.path(skillId)}${suffix}`)) as Record<
      string,
      unknown
    >;
  }

  async getBySlug(
    slug: string,
    opts?: { overlayDraft?: boolean },
  ): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams();
    if (opts?.overlayDraft === false) qs.set("overlay_draft", "false");
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return (await this.client.requestJson(
      "GET",
      `${this.path("by-slug", encodeURIComponent(slug))}${suffix}`,
    )) as Record<string, unknown>;
  }

  async create(payload: SkillCreatePayload): Promise<Record<string, unknown>> {
    return (await this.client.requestJson("POST", this.path(), jsonInit(payload))) as Record<
      string,
      unknown
    >;
  }

  async importText(
    skillMd: string,
    opts?: { visibility?: string; locales?: string[] },
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { skill_md: skillMd };
    if (opts?.visibility) payload.visibility = opts.visibility;
    if (opts?.locales) payload.locales = opts.locales;
    return (await this.client.requestJson(
      "POST",
      this.path("import"),
      jsonInit(payload),
    )) as Record<string, unknown>;
  }

  async importZip(
    zip: Buffer,
    opts?: { visibility?: string; locales?: string[] },
  ): Promise<Record<string, unknown>> {
    return (await this.client.requestForm(
      "POST",
      this.path("import-zip"),
      zipForm(zip, opts),
    )) as Record<string, unknown>;
  }

  async updateZip(skillId: number | string, zip: Buffer): Promise<Record<string, unknown>> {
    return (await this.client.requestForm(
      "PUT",
      this.path(skillId, "import-zip"),
      zipForm(zip),
    )) as Record<string, unknown>;
  }

  async exportZip(skillId: number | string): Promise<Buffer> {
    return this.client.requestRaw("GET", this.path(skillId, "export"));
  }

  async update(
    skillId: number | string,
    payload: SkillUpdatePayload,
  ): Promise<Record<string, unknown>> {
    return (await this.client.requestJson("PUT", this.path(skillId), jsonInit(payload))) as Record<
      string,
      unknown
    >;
  }

  async updateListing(
    skillId: number | string,
    payload: SkillListingPayload,
  ): Promise<Record<string, unknown>> {
    return (await this.client.requestJson(
      "PUT",
      this.path(skillId, "listing"),
      jsonInit(payload),
    )) as Record<string, unknown>;
  }

  async delete(skillId: number | string): Promise<void> {
    await this.client.requestJson("DELETE", this.path(skillId));
  }

  async setVisibility(
    skillId: number | string,
    visibility: "private" | "public",
  ): Promise<Record<string, unknown>> {
    return (await this.client.requestJson(
      "PUT",
      this.path(skillId, "visibility"),
      jsonInit({ visibility }),
    )) as Record<string, unknown>;
  }

  async setContentVisibility(
    skillId: number | string,
    contentVisibility: "open" | "closed",
  ): Promise<Record<string, unknown>> {
    return (await this.client.requestJson(
      "PUT",
      this.path(skillId, "content-visibility"),
      jsonInit({ content_visibility: contentVisibility }),
    )) as Record<string, unknown>;
  }

  async cancelReview(skillId: number | string): Promise<Record<string, unknown>> {
    return (await this.client.requestJson("POST", this.path(skillId, "cancel-review"))) as Record<
      string,
      unknown
    >;
  }

  async toggle(skillId: number | string, enabled: boolean): Promise<Record<string, unknown>> {
    return (await this.client.requestJson(
      "PUT",
      this.path(skillId, "toggle"),
      jsonInit({ enabled }),
    )) as Record<string, unknown>;
  }

  // ==================== Market ====================

  async listCategories(): Promise<Record<string, unknown>> {
    return (await this.client.requestJson("GET", this.path("market", "categories"))) as Record<
      string,
      unknown
    >;
  }

  async listMarket(params: SkillMarketParams = {}): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams();
    qs.set("tab", params.tab ?? "discover");
    qs.set("sort", params.sort ?? "featured");
    qs.set("limit", String(params.limit ?? 50));
    qs.set("offset", String(params.offset ?? 0));
    if (params.category) qs.set("category", params.category);
    if (params.q) qs.set("q", params.q);
    if (params.locale) qs.set("locale", params.locale);
    return (await this.client.requestJson(
      "GET",
      `${this.path("market")}?${qs.toString()}`,
    )) as Record<string, unknown>;
  }

  async install(skillId: number | string): Promise<Record<string, unknown>> {
    return (await this.client.requestJson("POST", this.path(skillId, "install"))) as Record<
      string,
      unknown
    >;
  }

  async uninstall(skillId: number | string): Promise<void> {
    await this.client.requestJson("DELETE", this.path(skillId, "install"));
  }

  async fork(skillId: number | string): Promise<Record<string, unknown>> {
    return (await this.client.requestJson("POST", this.path(skillId, "fork"))) as Record<
      string,
      unknown
    >;
  }

  async favorite(skillId: number | string): Promise<Record<string, unknown>> {
    return (await this.client.requestJson("POST", this.path(skillId, "favorite"))) as Record<
      string,
      unknown
    >;
  }

  async unfavorite(skillId: number | string): Promise<void> {
    await this.client.requestJson("DELETE", this.path(skillId, "favorite"));
  }

  async upgradeInfo(skillId: number | string): Promise<Record<string, unknown>> {
    return (await this.client.requestJson("GET", this.path(skillId, "upgrade-info"))) as Record<
      string,
      unknown
    >;
  }

  async upgrade(skillId: number | string): Promise<Record<string, unknown>> {
    return (await this.client.requestJson("POST", this.path(skillId, "upgrade"))) as Record<
      string,
      unknown
    >;
  }

  async report(skillId: number | string, reason?: string): Promise<Record<string, unknown>> {
    return (await this.client.requestJson(
      "POST",
      this.path(skillId, "report"),
      jsonInit(reason ? { reason } : {}),
    )) as Record<string, unknown>;
  }

  async createShare(
    skillId: number | string,
    regenerate = false,
  ): Promise<Record<string, unknown>> {
    return (await this.client.requestJson(
      "POST",
      this.path(skillId, "share"),
      jsonInit({ regenerate }),
    )) as Record<string, unknown>;
  }

  async revokeShare(skillId: number | string): Promise<Record<string, unknown>> {
    return (await this.client.requestJson("DELETE", this.path(skillId, "share"))) as Record<
      string,
      unknown
    >;
  }

  async installShared(token: string): Promise<Record<string, unknown>> {
    return (await this.client.requestJson(
      "POST",
      this.path("shared", encodeURIComponent(token), "install"),
    )) as Record<string, unknown>;
  }

  // ==================== Preset assets / covers ====================

  async presignCover(opts: {
    filename: string;
    contentType: string;
    fileSize?: number;
  }): Promise<Record<string, unknown>> {
    return (await this.client.requestJson(
      "POST",
      "/api/v1/upload/presign-skill-cover",
      jsonInit({
        filename: opts.filename,
        content_type: opts.contentType,
        file_size: opts.fileSize,
      }),
    )) as Record<string, unknown>;
  }

  async presignClip(opts: {
    filename: string;
    contentType: string;
    fileSize?: number;
  }): Promise<Record<string, unknown>> {
    return (await this.client.requestJson(
      "POST",
      "/api/v1/upload/presign-skill-clip",
      jsonInit({
        filename: opts.filename,
        content_type: opts.contentType,
        file_size: opts.fileSize,
      }),
    )) as Record<string, unknown>;
  }

  async uploadPresetAsset(
    skillId: number | string,
    file: UploadFile,
    key: string,
    opts?: { label?: string; writeToDraft?: boolean },
  ): Promise<Record<string, unknown>> {
    const form = fileForm(file, {
      key,
      label: opts?.label,
      write_to_draft: opts?.writeToDraft ?? true,
    });
    return (await this.client.requestForm(
      "POST",
      this.path(skillId, "preset-assets", "upload"),
      form,
    )) as Record<string, unknown>;
  }

  async bindPresetAsset(
    skillId: number | string,
    payload: {
      asset_id: string;
      key: string;
      label?: string;
      write_to_draft?: boolean;
    },
  ): Promise<Record<string, unknown>> {
    return (await this.client.requestJson(
      "POST",
      this.path(skillId, "preset-assets", "bind"),
      jsonInit(payload),
    )) as Record<string, unknown>;
  }

  async unbindPresetAsset(
    skillId: number | string,
    assetId: string,
    writeToDraft = true,
  ): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams({ write_to_draft: String(writeToDraft) });
    return (await this.client.requestJson(
      "DELETE",
      `${this.path(skillId, "preset-assets", encodeURIComponent(assetId))}?${qs.toString()}`,
    )) as Record<string, unknown>;
  }

  // ==================== Knowledge base ====================

  async listKbDocuments(
    skillId: number | string,
    preferDraft = true,
  ): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams({ prefer_draft: String(preferDraft) });
    return (await this.client.requestJson(
      "GET",
      `${this.path(skillId, "kb-documents")}?${qs.toString()}`,
    )) as Record<string, unknown>;
  }

  async uploadKbDocument(
    skillId: number | string,
    file: UploadFile,
    opts?: { docId?: string; title?: string; writeToDraft?: boolean },
  ): Promise<Record<string, unknown>> {
    const form = fileForm(file, {
      doc_id: opts?.docId,
      title: opts?.title,
      write_to_draft: opts?.writeToDraft ?? true,
    });
    return (await this.client.requestForm(
      "POST",
      this.path(skillId, "kb-documents", "upload"),
      form,
    )) as Record<string, unknown>;
  }

  async deleteKbDocument(
    skillId: number | string,
    docId: string,
    writeToDraft = true,
  ): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams({ write_to_draft: String(writeToDraft) });
    return (await this.client.requestJson(
      "DELETE",
      `${this.path(skillId, "kb-documents", encodeURIComponent(docId))}?${qs.toString()}`,
    )) as Record<string, unknown>;
  }

  async listKbEntries(
    skillId: number | string,
    opts?: { limit?: number; offset?: number },
  ): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams();
    if (opts?.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) qs.set("offset", String(opts.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return (await this.client.requestJson(
      "GET",
      `${this.path(skillId, "kb", "entries")}${suffix}`,
    )) as Record<string, unknown>;
  }

  async queryKb(
    skillId: number | string,
    query: string,
    opts?: { kind?: string; limit?: number },
  ): Promise<Record<string, unknown>> {
    return (await this.client.requestJson(
      "POST",
      this.path(skillId, "kb", "query"),
      jsonInit({ query, kind: opts?.kind, limit: opts?.limit }),
    )) as Record<string, unknown>;
  }

  async createKbEntry(
    skillId: number | string,
    payload: {
      content: string;
      kind?: string;
      tags?: string[];
      metadata?: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    return (await this.client.requestJson(
      "POST",
      this.path(skillId, "kb", "entries"),
      jsonInit(payload),
    )) as Record<string, unknown>;
  }

  async updateKbEntry(
    skillId: number | string,
    memoryId: number | string,
    payload: {
      content?: string;
      kind?: string;
      tags?: string[];
      metadata?: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    return (await this.client.requestJson(
      "PUT",
      this.path(skillId, "kb", "entries", memoryId),
      jsonInit(payload),
    )) as Record<string, unknown>;
  }

  async deleteKbEntry(skillId: number | string, memoryId: number | string): Promise<void> {
    await this.client.requestJson("DELETE", this.path(skillId, "kb", "entries", memoryId));
  }

  // ==================== Creator stats ====================

  async getCreatorOverview(from: string, to: string): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams({ from, to });
    return (await this.client.requestJson(
      "GET",
      `/api/v1/creator/overview?${qs.toString()}`,
    )) as Record<string, unknown>;
  }

  async getCreatorSkillStats(
    skillId: number | string,
    params: CreatorStatsParams,
  ): Promise<Record<string, unknown>> {
    const qs = new URLSearchParams();
    if (params.period) qs.set("period", params.period);
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return (await this.client.requestJson(
      "GET",
      `/api/v1/creator/skills/${skillId}/stats${suffix}`,
    )) as Record<string, unknown>;
  }
}
