/**
 * Helpers for turning `asset` SSE events into something viewable in the
 * terminal: deciding whether an asset type can be inlined, picking a
 * provider URL out of a presigned-urls response, and downloading the
 * bytes with sane timeout/size guards.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MiB

/** Only images are rendered inline; video/audio/documents just get a link. */
export function isInlineImage(type: string | undefined): boolean {
  return type === "image";
}

/**
 * Pick the first URL available from a provider->url map, preferring the
 * providers listed on the asset itself (in order), falling back to
 * whatever key exists.
 */
export function pickUrl(
  urls: Record<string, string> | null | undefined,
  preferredProviders?: string[] | null,
): string | undefined {
  if (!urls) return undefined;
  for (const provider of preferredProviders ?? []) {
    const url = urls[provider];
    if (url) return url;
  }
  const first = Object.values(urls).find((url): url is string => Boolean(url));
  return first;
}

export interface FetchImageOptions {
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

/** Download an image's bytes with a timeout and a max-size guard. */
export async function fetchImageBuffer(url: string, opts?: FetchImageOptions): Promise<Buffer> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const fetchImpl = opts?.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, { signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`Failed to download image: HTTP ${resp.status}`);
    }
    const contentLength = resp.headers.get("content-length");
    if (contentLength && Number(contentLength) > maxBytes) {
      throw new Error(`Image too large (${contentLength} bytes > ${maxBytes} max)`);
    }
    if (!resp.body) {
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.byteLength > maxBytes) {
        throw new Error(`Image too large (${buf.byteLength} bytes > ${maxBytes} max)`);
      }
      return buf;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = resp.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) {
            throw new Error(`Image too large (>${maxBytes} bytes max)`);
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}
