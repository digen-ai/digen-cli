import { Box, Text } from "ink";
import terminalLink from "terminal-link";
import type { AssetLineData, StatusTone, TranscriptLine } from "../transcript.js";
import { colorForAgent } from "./colors.js";

const ASSET_ICONS: Record<string, string> = {
  image: "🖼",
  video: "🎬",
  audio: "🎵",
  document: "📄",
};

function assetIcon(assetType: string): string {
  return ASSET_ICONS[assetType] ?? "📎";
}

function assetLabel(data: AssetLineData): string {
  return `${assetIcon(data.assetType)} ${data.assetType}${data.name ? `: ${data.name}` : ""}`;
}

/**
 * The link portion of an asset line. When resolved to an `http(s)` URL, this
 * wraps it as an OSC 8 terminal hyperlink so a real click (no custom mouse
 * tracking involved) opens it in the browser; `terminal-link` degrades to
 * plain text automatically on terminals that don't understand OSC 8.
 */
function assetSuffix(data: AssetLineData): string {
  if (data.placeholder) return "(generating…)";
  if (data.status === "pending") return "resolving…";
  if (!data.url) return "(link unavailable)";
  if (data.url.startsWith("http")) return terminalLink(data.url, data.url, { fallback: false });
  return data.url;
}

const TONE_PROPS: Record<StatusTone, { color?: string; dimColor?: boolean }> = {
  info: {},
  success: { color: "green" },
  error: { color: "red" },
  warn: { color: "yellow" },
  dim: { dimColor: true },
};

export interface TranscriptLineViewProps {
  line: TranscriptLine;
}

export function TranscriptLineView({ line }: TranscriptLineViewProps) {
  switch (line.kind) {
    case "user":
      return (
        <Box>
          <Text color="cyan" bold>
            you:{" "}
          </Text>
          <Text>{line.text}</Text>
        </Box>
      );

    case "agentHeader":
      return (
        <Text color={colorForAgent(line.agent)} bold>
          {line.agent}
        </Text>
      );

    case "text":
      return <Text>{line.content}</Text>;

    case "thinking":
      return (
        <Text dimColor italic>
          thinking… {line.content}
        </Text>
      );

    case "tool": {
      const icon = line.status === "running" ? "⚙" : line.status === "success" ? "✔" : "✘";
      const color =
        line.status === "success" ? "green" : line.status === "error" ? "red" : undefined;
      return (
        <Text dimColor={line.status === "running"} color={color}>
          {"  "}
          {icon} {line.name}
          {line.status === "running" ? "…" : ""}
        </Text>
      );
    }

    case "asset":
      return (
        <Box>
          <Text dimColor>
            {"  "}
            {assetLabel(line.data)}{" "}
          </Text>
          <Text dimColor>{assetSuffix(line.data)}</Text>
        </Box>
      );

    case "guidanceHeader":
      return <Text dimColor>Suggested follow-ups:</Text>;

    case "guidanceItem":
      return (
        <Text dimColor>
          {"  "}• {line.text}
        </Text>
      );

    case "status":
      return <Text {...TONE_PROPS[line.tone]}>{line.text}</Text>;

    default:
      return null;
  }
}
