import { describe, expect, it } from "vitest";
import type { DigenClient, PresignResponse } from "../src/lib/client.js";
import { TranscriptStore } from "../src/ui/transcript.js";

function fakeClient(impl: (items: unknown) => Promise<PresignResponse>): DigenClient {
  return { getPresignedUrls: impl } as unknown as DigenClient;
}

function assetLine(store: TranscriptStore) {
  const line = store.getLines().find((l) => l.kind === "asset");
  if (!line || line.kind !== "asset") throw new Error("no asset line found");
  return line;
}

describe("TranscriptStore asset handling", () => {
  it("resolves an image asset to an https link via presign", async () => {
    const client = fakeClient(async () => ({
      results: [
        {
          asset_id: "img_1",
          urls: { aws: "https://bucket.s3.example/img_1.jpg" },
          thumbnail_urls: { aws: "https://bucket.s3.example/img_1_thumb.jpg" },
          error: null,
        },
      ],
      expires_at: "2026-02-06T13:00:00Z",
    }));
    const store = new TranscriptStore({ client, images: "auto" });

    store.handle({
      type: "asset",
      data: {
        type: "image",
        name: "cat.jpg",
        asset_id: "img_1",
        providers: ["aws"],
        thumb_providers: ["aws"],
        uri: "s3://bucket/img_1.jpg",
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const line = assetLine(store);
    expect(line.data.status).toBe("resolved");
    expect(line.data.url).toBe("https://bucket.s3.example/img_1.jpg");
  });

  it("falls back to the s3 uri link when presign returns an error", async () => {
    const client = fakeClient(async () => ({
      results: [
        {
          asset_id: "img_1",
          urls: {},
          thumbnail_urls: null,
          error: "Access denied to asset: img_1",
        },
      ],
      expires_at: "2026-02-06T13:00:00Z",
    }));
    const store = new TranscriptStore({ client, images: "auto" });

    store.handle({
      type: "asset",
      data: {
        type: "image",
        name: "cat.jpg",
        asset_id: "img_1",
        providers: ["aws"],
        uri: "s3://bucket/img_1.jpg",
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const line = assetLine(store);
    expect(line.data.status).toBe("error");
    expect(line.data.url).toBe("s3://bucket/img_1.jpg");
  });

  it("does not presign a placeholder asset", async () => {
    const client = fakeClient(async () => {
      throw new Error("should not be called");
    });
    const store = new TranscriptStore({ client, images: "auto" });

    store.handle({
      type: "asset",
      phase: "placeholder",
      data: { type: "image", name: "cat.jpg" },
    });
    await Promise.resolve();

    const line = assetLine(store);
    expect(line.data.placeholder).toBe(true);
    expect(line.data.status).toBe("pending");
  });

  it("shows the raw uri immediately without presigning when images are disabled", async () => {
    const client = fakeClient(async () => {
      throw new Error("should not be called when images are off");
    });
    const store = new TranscriptStore({ client, images: "off" });

    store.handle({
      type: "asset",
      data: {
        type: "image",
        asset_id: "img_1",
        providers: ["aws"],
        uri: "s3://bucket/img_1.jpg",
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    const line = assetLine(store);
    expect(line.data.status).toBe("resolved");
    expect(line.data.url).toBe("s3://bucket/img_1.jpg");
  });

  it("resolves a video (or any other non-image type) to an https link via presign", async () => {
    const client = fakeClient(async () => ({
      results: [
        {
          asset_id: "vid_1",
          urls: { aws: "https://bucket.s3.example/vid_1.mp4" },
          thumbnail_urls: null,
          error: null,
        },
      ],
      expires_at: "2026-02-06T13:00:00Z",
    }));
    const store = new TranscriptStore({ client, images: "auto" });

    store.handle({
      type: "asset",
      data: {
        type: "video",
        asset_id: "vid_1",
        providers: ["aws"],
        uri: "s3://bucket/vid_1.mp4",
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const line = assetLine(store);
    expect(line.data.status).toBe("resolved");
    expect(line.data.url).toBe("https://bucket.s3.example/vid_1.mp4");
  });

  it("skips presigning and shows the direct url as-is when the event already carries one", async () => {
    const client = fakeClient(async () => {
      throw new Error("should not be called when a direct url is present");
    });
    const store = new TranscriptStore({ client, images: "auto" });

    store.handle({
      type: "asset",
      data: {
        type: "image",
        url: "https://cdn.example/already-resolved.jpg",
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    const line = assetLine(store);
    expect(line.data.status).toBe("resolved");
    expect(line.data.url).toBe("https://cdn.example/already-resolved.jpg");
  });
});

describe("TranscriptStore text/thinking/tool aggregation", () => {
  it("groups consecutive chunks from the same agent into one line with a single header", () => {
    const store = new TranscriptStore({ images: "off" });
    store.handle({ type: "chunk", agent: "writer", content: "Hello" });
    store.handle({ type: "chunk", agent: "writer", content: ", world" });

    const lines = store.getLines();
    expect(lines.filter((l) => l.kind === "agentHeader")).toHaveLength(1);
    const textLines = lines.filter((l) => l.kind === "text");
    expect(textLines).toHaveLength(1);
    expect(textLines[0]).toMatchObject({ agent: "writer", content: "Hello, world" });
  });

  it("starts a new paragraph when the agent changes", () => {
    const store = new TranscriptStore({ images: "off" });
    store.handle({ type: "chunk", agent: "writer", content: "draft" });
    store.handle({ type: "chunk", agent: "critic", content: "review" });

    const textLines = store.getLines().filter((l) => l.kind === "text");
    expect(textLines).toHaveLength(2);
    expect(textLines[0]).toMatchObject({ agent: "writer", content: "draft" });
    expect(textLines[1]).toMatchObject({ agent: "critic", content: "review" });
  });

  it("accumulates thinking content between start and end and marks it done", () => {
    const store = new TranscriptStore({ images: "off" });
    store.handle({ type: "thinking", phase: "start" });
    store.handle({ type: "thinking", content: "pondering" });
    store.handle({ type: "thinking", content: "…" });
    store.handle({ type: "thinking", phase: "end" });

    const thinking = store.getLines().find((l) => l.kind === "thinking");
    expect(thinking).toMatchObject({ content: "pondering…", done: true });
  });

  it("updates a running tool line in place instead of appending a new one", () => {
    const store = new TranscriptStore({ images: "off" });
    store.handle({ type: "tool", tool: "search", phase: "start" });
    store.handle({ type: "tool", tool: "search", phase: "end", status: "success" });

    const toolLines = store.getLines().filter((l) => l.kind === "tool");
    expect(toolLines).toHaveLength(1);
    expect(toolLines[0]).toMatchObject({ name: "search", status: "success" });
  });

  it("marks a failed tool call", () => {
    const store = new TranscriptStore({ images: "off" });
    store.handle({ type: "tool", tool: "search", phase: "start" });
    store.handle({ type: "tool", tool: "search", phase: "end", status: "error" });

    const toolLines = store.getLines().filter((l) => l.kind === "tool");
    expect(toolLines[0]).toMatchObject({ status: "error" });
  });
});

describe("TranscriptStore guidance", () => {
  it("prints text from object-form suggested_questions", () => {
    const store = new TranscriptStore({ images: "off" });
    store.handle({
      type: "guidance",
      data: {
        suggested_questions: [
          { text: "开始设计角色/场景视觉" },
          { text: "再调整一下这场戏", action: { type: "send_message" } },
        ],
      },
    });

    const items = store.getLines().filter((l) => l.kind === "guidanceItem");
    expect(items.map((l) => (l.kind === "guidanceItem" ? l.text : ""))).toEqual([
      "开始设计角色/场景视觉",
      "再调整一下这场戏",
    ]);
  });

  it("skips items without a usable label and omits the header when nothing qualifies", () => {
    const store = new TranscriptStore({ images: "off" });
    store.handle({
      type: "guidance",
      data: { suggested_questions: [{ action: { type: "fill_input" } }, "", "  "] },
    });

    expect(store.getLines().some((l) => l.kind === "guidanceHeader")).toBe(false);
  });
});

describe("TranscriptStore turns", () => {
  it("tags lines with the current turn and freezes prior turns on startTurn", () => {
    const store = new TranscriptStore({ images: "off" });
    store.startTurn("hi");
    store.handle({ type: "chunk", agent: "assistant", content: "hello" });
    store.handle({ type: "done" });

    expect(store.getCurrentTurn()).toBe(1);
    expect(store.getLines().every((l) => l.turn === 1)).toBe(true);

    store.startTurn("again");
    store.handle({ type: "chunk", agent: "assistant", content: "hi again" });

    expect(store.getCurrentTurn()).toBe(2);
    const turns = new Set(store.getLines().map((l) => l.turn));
    expect(turns).toEqual(new Set([1, 2]));
  });

  it("notifies subscribers whenever a line is pushed or updated", async () => {
    const store = new TranscriptStore({ images: "off" });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications++;
    });

    store.handle({ type: "thinking", phase: "start" });
    store.handle({ type: "thinking", content: "..." });
    expect(notifications).toBe(2);

    unsubscribe();
    store.handle({ type: "thinking", phase: "end" });
    expect(notifications).toBe(2);
  });
});
