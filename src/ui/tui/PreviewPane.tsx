import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { type AssetLineData, isPreviewable } from "../transcript.js";
import { getAnsiThumbnail } from "./preview.js";

const PREVIEW_WIDTH = 40;

type ThumbState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; art: string }
  | { status: "error" };

export function PreviewPane({ data }: { data: AssetLineData }) {
  const previewable = isPreviewable(data);
  const [thumb, setThumb] = useState<ThumbState>({ status: "idle" });

  useEffect(() => {
    if (!previewable || !data.thumbUrl) {
      setThumb({ status: "idle" });
      return;
    }
    let cancelled = false;
    setThumb({ status: "loading" });
    getAnsiThumbnail(data.thumbUrl, PREVIEW_WIDTH)
      .then((art) => {
        if (!cancelled) setThumb({ status: "ready", art });
      })
      .catch(() => {
        if (!cancelled) setThumb({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
    // Re-fetch only when the thumbnail source actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewable, data.thumbUrl]);

  const canOpen = data.status === "resolved" && Boolean(data.url?.startsWith("http"));

  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1} width={PREVIEW_WIDTH + 4}>
      <Text bold>
        {data.assetType}
        {data.name ? `: ${data.name}` : ""}
      </Text>
      {previewable && thumb.status === "loading" && <Text dimColor>Loading preview…</Text>}
      {previewable && thumb.status === "ready" && <Text>{thumb.art}</Text>}
      {previewable && thumb.status === "error" && <Text dimColor>Preview unavailable</Text>}
      {!previewable && (
        <Text dimColor>
          {data.assetType === "video"
            ? "No thumbnail — click to open in browser"
            : "No inline preview for this type"}
        </Text>
      )}
      <Text dimColor wrap="truncate-middle">
        {data.url ?? "(no link available)"}
      </Text>
      {canOpen && <Text dimColor>click to open ↗</Text>}
    </Box>
  );
}
