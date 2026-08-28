import { useOnClick, useOnMouseEnter, useOnMouseLeave } from "@ink-tools/ink-mouse";
import { Box, type DOMElement, Text } from "ink";
import { useRef } from "react";
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

function assetSuffix(data: AssetLineData): string {
  if (data.placeholder) return "(generating…)";
  if (data.status === "pending") return "resolving…";
  if (data.url) return data.url;
  return "(link unavailable)";
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
  /** Only live (current-turn) lines get mouse hooks — history that's scrolled into the
   * terminal's own scrollback can no longer be hit-tested against the mouse position. */
  interactive: boolean;
  onHoverAsset?: (line: { id: string } | null) => void;
  onOpenAsset?: (data: AssetLineData) => void;
}

export function TranscriptLineView({
  line,
  interactive,
  onHoverAsset,
  onOpenAsset,
}: TranscriptLineViewProps) {
  const ref = useRef<DOMElement>(null);
  const isAsset = line.kind === "asset";
  const active = interactive && isAsset;

  useOnMouseEnter(ref, active ? () => onHoverAsset?.({ id: line.id }) : null);
  useOnMouseLeave(ref, active ? () => onHoverAsset?.(null) : null);
  useOnClick(ref, active && line.kind === "asset" ? () => onOpenAsset?.(line.data) : null);

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
        <Box ref={ref}>
          <Text color={interactive ? "blueBright" : undefined} dimColor={!interactive}>
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
