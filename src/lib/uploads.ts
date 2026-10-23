/**
 * Local attachment staging and upload for `/attach` and `digen upload`.
 *
 * Runs the presign -> S3 PUT -> register-asset pipeline documented in
 * vid-agent `docs/API_REFERENCE.md` section 5, turning each staged file into
 * the matching chat block (`image`, `video`, `audio`, or `document`).
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, resolve } from "node:path";
import type { ChatBlock, DigenClient } from "./client.js";

export type AssetType = "image" | "video" | "audio" | "document";

interface FileTypeInfo {
  contentType: string;
  assetType: AssetType;
}

const FILE_TYPES: Record<string, FileTypeInfo> = {
  // Images
  ".jpg": { contentType: "image/jpeg", assetType: "image" },
  ".jpeg": { contentType: "image/jpeg", assetType: "image" },
  ".png": { contentType: "image/png", assetType: "image" },
  ".gif": { contentType: "image/gif", assetType: "image" },
  ".webp": { contentType: "image/webp", assetType: "image" },
  // Video
  ".mp4": { contentType: "video/mp4", assetType: "video" },
  ".webm": { contentType: "video/webm", assetType: "video" },
  // Audio
  ".mp3": { contentType: "audio/mpeg", assetType: "audio" },
  ".wav": { contentType: "audio/wav", assetType: "audio" },
  ".ogg": { contentType: "audio/ogg", assetType: "audio" },
  ".flac": { contentType: "audio/flac", assetType: "audio" },
  ".m4a": { contentType: "audio/mp4", assetType: "audio" },
  // Documents
  ".pdf": { contentType: "application/pdf", assetType: "document" },
  ".docx": {
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    assetType: "document",
  },
  ".txt": { contentType: "text/plain", assetType: "document" },
  ".md": { contentType: "text/markdown", assetType: "document" },
};

const IMAGE_TYPES = new Set(
  Object.keys(FILE_TYPES).filter((ext) => FILE_TYPES[ext]?.assetType === "image"),
);

export interface StagedAttachment {
  /** Absolute path on disk. */
  path: string;
  /** Original filename, used as the asset's display name. */
  name: string;
  size: number;
  /** MIME type sent to the presign and register endpoints. */
  contentType: string;
  /** Asset/block type inferred from the extension. */
  assetType: AssetType;
  /** Chat block type; currently identical to assetType. */
  blockType: AssetType;
}

/** Backwards-compatible alias for the old image-only staging type. */
export type StagedImage = StagedAttachment;

/** Extension -> MIME type for the image formats the upload API accepts; `null` if unsupported. */
export function imageContentTypeForPath(path: string): string | null {
  const ext = extname(path).toLowerCase();
  return IMAGE_TYPES.has(ext) ? (FILE_TYPES[ext]?.contentType ?? null) : null;
}

/** Extension -> upload metadata for every supported attachment type. */
export function attachmentInfoForPath(path: string): FileTypeInfo | null {
  return FILE_TYPES[extname(path).toLowerCase()] ?? null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

/** Strips a single layer of matching surrounding quotes, e.g. from a dragged-and-dropped path. */
function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

/** Validates a user-supplied path and stages it for upload. Throws a friendly `Error` on failure. */
export function stageAttachment(rawPath: string): StagedAttachment {
  const cleaned = unquote(rawPath);
  if (!cleaned) {
    throw new Error("Usage: /attach <path>");
  }
  const path = resolve(expandHome(cleaned));

  const info = attachmentInfoForPath(path);
  if (!info) {
    throw new Error(
      `Unsupported file type: ${extname(path) || "(no extension)"} — supported: .jpg, .jpeg, .png, .gif, .webp, .mp4, .webm, .mp3, .wav, .ogg, .flac, .m4a, .pdf, .docx, .txt, .md`,
    );
  }

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`File not found: ${path}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${path}`);
  }

  return {
    path,
    name: basename(path),
    size: stat.size,
    contentType: info.contentType,
    assetType: info.assetType,
    blockType: info.assetType,
  };
}

/** Stage an image only (legacy `/attach` semantics used by existing callers/tests). */
export function stageImage(rawPath: string): StagedImage {
  const staged = stageAttachment(rawPath);
  if (staged.assetType !== "image") {
    throw new Error(
      `Unsupported file type: ${extname(staged.path) || "(no extension)"} — supported: .jpg, .jpeg, .png, .gif, .webp`,
    );
  }
  return staged;
}

/** Runs the presign -> S3 PUT -> register pipeline for one attachment, returning its chat block. */
export async function uploadAttachment(
  client: DigenClient,
  conversationId: string,
  staged: StagedAttachment,
  opts?: { metadata?: Record<string, unknown> },
): Promise<ChatBlock> {
  const presigned = await client.presignUpload(conversationId, {
    filename: staged.name,
    contentType: staged.contentType,
  });

  if (staged.size > presigned.max_size) {
    throw new Error(
      `${staged.name} is too large (${formatBytes(staged.size)} > ${formatBytes(presigned.max_size)} max)`,
    );
  }

  const bytes = readFileSync(staged.path);
  await client.uploadToPresignedUrl(presigned.upload_url, bytes, staged.contentType);

  const asset = await client.registerUploadedAsset(conversationId, {
    url: presigned.final_url,
    assetType: staged.assetType,
    contentType: staged.contentType,
    filename: staged.name,
    metadata: opts?.metadata,
  });

  const blockType = (asset.type as AssetType | undefined) ?? staged.blockType;
  return {
    type: blockType,
    uri: asset.uri,
    providers: asset.providers,
    source: "user_upload",
    asset_id: asset.asset_id,
    name: staged.name,
  };
}

/** Legacy name for image callers. */
export async function uploadImageFile(
  client: DigenClient,
  conversationId: string,
  staged: StagedImage,
): Promise<ChatBlock> {
  return uploadAttachment(client, conversationId, staged);
}

/**
 * Uploads all staged attachments (sequentially, reporting progress) and
 * combines them with explicit skill invocations and the text into the block
 * list a chat message should send. Skill blocks stay ahead of the text block
 * so the server can match its `/name` tokens against the verbatim text.
 */
export async function buildMessageBlocks(
  client: DigenClient,
  conversationId: string,
  staged: StagedAttachment[],
  text: string,
  onProgress?: (staged: StagedAttachment, index: number, total: number) => void,
  skillBlocks: ChatBlock[] = [],
): Promise<ChatBlock[]> {
  const blocks: ChatBlock[] = [];
  for (let i = 0; i < staged.length; i++) {
    const attachment = staged[i];
    if (!attachment) continue;
    onProgress?.(attachment, i, staged.length);
    blocks.push(await uploadAttachment(client, conversationId, attachment));
  }
  blocks.push(...skillBlocks);
  const trimmed = text.trim();
  if (trimmed) {
    blocks.push({ type: "text", content: trimmed });
  }
  return blocks;
}

/** Wait for every document block in a message to finish parsing before sending. */
export async function waitForDocumentBlocks(
  client: DigenClient,
  conversationId: string,
  blocks: ChatBlock[],
  opts?: WaitOptions,
): Promise<void> {
  for (const block of blocks) {
    if (block.type !== "document" || !block.asset_id) continue;
    const status = await waitForAssetParsing(client, conversationId, String(block.asset_id), opts);
    if (status.parsing_status === "failed") {
      throw new Error(`Document parsing failed for ${String(block.name ?? block.asset_id)}`);
    }
  }
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  onPoll?: (status: Record<string, unknown>) => void;
}

/** Poll a document asset until parsing completes/fails, or the timeout elapses. */
export async function waitForAssetParsing(
  client: DigenClient,
  conversationId: string,
  assetId: string,
  opts: WaitOptions = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const status = await client.getAssetStatus(conversationId, assetId);
    opts.onPoll?.(status);
    const parsing = String(status.parsing_status ?? "");
    if (parsing === "completed" || parsing === "failed") return status;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${assetId} to finish parsing (last status: ${parsing || "unknown"})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
