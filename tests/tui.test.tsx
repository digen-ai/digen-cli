import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { DigenClient } from "../src/lib/client.js";
import type { TranscriptLine } from "../src/ui/transcript.js";
import { ChatTui } from "../src/ui/tui/App.js";
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
        providers: ["aws"],
      },
    };
    const { lastFrame } = render(<TranscriptLineView line={line} />);
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
    const { lastFrame } = render(<TranscriptLineView line={line} />);
    expect(lastFrame()).toContain("generating");
  });
});
