/**
 * Lazy, cached ANSI-art thumbnails for the hover preview pane. Only called
 * when the user actually hovers a previewable asset row (see
 * `isPreviewable` in `ui/transcript.ts`), so we never download bytes for
 * assets nobody looks at.
 */

import terminalImage from "terminal-image";
import { fetchImageBuffer } from "../../lib/assets.js";

const cache = new Map<string, Promise<string>>();

export function getAnsiThumbnail(url: string, width: number): Promise<string> {
  const key = `${width}:${url}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const promise = fetchImageBuffer(url).then((buffer) => terminalImage.buffer(buffer, { width }));
  promise.catch(() => cache.delete(key));
  cache.set(key, promise);
  return promise;
}
