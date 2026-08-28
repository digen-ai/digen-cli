/**
 * Local-image staging and upload for `/attach`: validates a path, stages it
 * in memory, then (at send time) runs the presign -> S3 PUT -> register
 * asset pipeline documented in vid-agent `docs/API_REFERENCE.md` section 5,
 * turning each staged file into an `image` chat block.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, resolve } from "node:path";
import type { ChatBlock, DigenClient } from "./client.js";

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export interface StagedImage {
  /** Absolute path on disk. */
  path: string;
  /** Original filename, used as the asset's display name. */
  name: string;
  size: number;
  contentType: string;
}

/** Extension -> MIME type for the image formats the upload API accepts; `null` if unsupported. */
export function imageContentTypeForPath(path: string): string | null {
  return IMAGE_CONTENT_TYPES[extname(path).toLowerCase()] ?? null;
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
export function stageImage(rawPath: string): StagedImage {
  const cleaned = unquote(rawPath);
  if (!cleaned) {
    throw new Error("Usage: /attach <path-to-image>");
  }
  const path = resolve(expandHome(cleaned));

  const contentType = imageContentTypeForPath(path);
  if (!contentType) {
    throw new Error(
      `Unsupported file type: ${extname(path) || "(no extension)"} — supported: .jpg, .jpeg, .png, .gif, .webp`,
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

  return { path, name: basename(path), size: stat.size, contentType };
}

/** Runs the presign -> S3 PUT -> register pipeline for one staged image, returning its chat block. */
export async function uploadImageFile(
  client: DigenClient,
  conversationId: string,
  staged: StagedImage,
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
    assetType: "image",
    contentType: staged.contentType,
    filename: staged.name,
  });

  return {
    type: "image",
    uri: asset.uri,
    providers: asset.providers,
    source: "user_upload",
    asset_id: asset.asset_id,
    name: staged.name,
  };
}

/**
 * Uploads all staged images (sequentially, reporting progress) and combines
 * them with the text into the block list a chat message should send. Text is
 * omitted entirely when empty, so an image-only message is valid.
 */
export async function buildMessageBlocks(
  client: DigenClient,
  conversationId: string,
  staged: StagedImage[],
  text: string,
  onProgress?: (staged: StagedImage, index: number, total: number) => void,
): Promise<ChatBlock[]> {
  const blocks: ChatBlock[] = [];
  for (let i = 0; i < staged.length; i++) {
    const image = staged[i];
    if (!image) continue;
    onProgress?.(image, i, staged.length);
    blocks.push(await uploadImageFile(client, conversationId, image));
  }
  const trimmed = text.trim();
  if (trimmed) {
    blocks.push({ type: "text", content: trimmed });
  }
  return blocks;
}
