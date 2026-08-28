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

  it("keeps the label and a long hyperlinked url as one continuous run", () => {
    // Regression test: putting the label and link in separate sibling `Text`
    // nodes inside a `Box` makes Ink wrap them as independent flex columns,
    // which — once the combined content overflows the terminal width —
    // interleaves their wrapped lines into scrambled, unclickable output.
    const longUrl = `https://cdn.example/${"a".repeat(120)}.jpg?token=${"b".repeat(80)}`;
    const line: TranscriptLine = {
      id: "l1",
      turn: 1,
      kind: "asset",
      data: {
        assetType: "image",
        name: "Mountain Lake at Golden Hour",
        placeholder: false,
        status: "resolved",
        url: longUrl,
        providers: ["aws"],
      },
    };
    const { lastFrame } = render(<TranscriptLineView line={line} />);
    // Strip OSC 8 hyperlink escapes and the soft line-wraps Ink inserts so we
    // can check the underlying text is one uninterrupted run — if the label
    // and link were laid out as separate flex columns, their wrapped lines
    // would interleave and this reassembled text would come out scrambled.
    const visible = (lastFrame() ?? "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping OSC 8 hyperlink escapes for the assertion
      .replace(/\u001B\][^\u0007]*\u0007/g, "")
      .replace(/\n/g, "");
    expect(visible).toContain("image: Mountain Lake at Golden Hour");
    expect(visible).toContain(longUrl);
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
