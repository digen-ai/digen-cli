import { MouseProvider } from "@ink-tools/ink-mouse";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { DigenClient } from "../src/lib/client.js";
import type { AssetLineData, TranscriptLine } from "../src/ui/transcript.js";
import { ChatTui } from "../src/ui/tui/App.js";
import { PreviewPane } from "../src/ui/tui/PreviewPane.js";
import { TranscriptLineView } from "../src/ui/tui/TranscriptLineView.js";

function fakeClient(): DigenClient {
  return {} as unknown as DigenClient;
}

describe("ChatTui", () => {
  it("mounts without crashing and shows the conversation header", () => {
    const { lastFrame, unmount } = render(
      <ChatTui client={fakeClient()} conversationId="conv_1" workflow="skill_agent" />,
    );

    const frame = lastFrame();
    expect(frame).toContain("conv_1");
    expect(frame).toContain("skill_agent");
    expect(frame).toContain(">");

    unmount();
  });
});

describe("TranscriptLineView", () => {
  it("renders a resolved image asset line with its link", () => {
    const line: TranscriptLine = {
      id: "l1",
      turn: 1,
      kind: "asset",
      data: {
        assetType: "image",
        name: "cat.jpg",
        placeholder: false,
        status: "resolved",
        url: "https://cdn.example/cat.jpg",
        thumbUrl: "https://cdn.example/cat.jpg",
        providers: ["aws"],
      },
    };
    const { lastFrame } = render(
      <MouseProvider>
        <TranscriptLineView line={line} interactive={false} />
      </MouseProvider>,
    );
    const frame = lastFrame();
    expect(frame).toContain("image: cat.jpg");
    expect(frame).toContain("https://cdn.example/cat.jpg");
  });

  it("renders a placeholder asset as generating", () => {
    const line: TranscriptLine = {
      id: "l1",
      turn: 1,
      kind: "asset",
      data: {
        assetType: "video",
        name: "",
        placeholder: true,
        status: "pending",
        providers: [],
      },
    };
    const { lastFrame } = render(
      <MouseProvider>
        <TranscriptLineView line={line} interactive={false} />
      </MouseProvider>,
    );
    expect(lastFrame()).toContain("generating");
  });
});

describe("PreviewPane", () => {
  it("shows metadata and a hint to click through for non-previewable types", () => {
    const data: AssetLineData = {
      assetType: "document",
      name: "report.pdf",
      placeholder: false,
      status: "resolved",
      url: "https://cdn.example/report.pdf",
      providers: ["aws"],
    };
    const { lastFrame } = render(<PreviewPane data={data} />);
    const frame = lastFrame();
    expect(frame).toContain("report.pdf");
    expect(frame).toContain("No inline preview");
    expect(frame).toContain("https://cdn.example/report.pdf");
  });
});
