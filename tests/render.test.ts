import { afterEach, describe, expect, it, vi } from "vitest";
import type { DigenClient, PresignResponse } from "../src/lib/client.js";
import { ChatRenderer } from "../src/ui/render.js";

function fakeClient(impl: (items: unknown) => Promise<PresignResponse>): DigenClient {
  return { getPresignedUrls: impl } as unknown as DigenClient;
}

function captureOutput() {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { chunks, spy, text: () => chunks.join("") };
}

describe("ChatRenderer asset handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves an image to a plain link via presign — no inline rendering here", async () => {
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
    const renderer = new ChatRenderer({ client, images: "auto" });
    const out = captureOutput();

    renderer.handle({
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
    await renderer.flushAssets();

    const text = out.text();
    expect(text).toContain("https://bucket.s3.example/img_1.jpg");
    expect(text).not.toContain("s3://bucket/img_1.jpg");
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
    const renderer = new ChatRenderer({ client, images: "auto" });
    const out = captureOutput();

    renderer.handle({
      type: "asset",
      data: {
        type: "image",
        name: "cat.jpg",
        asset_id: "img_1",
        providers: ["aws"],
        uri: "s3://bucket/img_1.jpg",
      },
    });
    await renderer.flushAssets();

    expect(out.text()).toContain("s3://bucket/img_1.jpg");
  });

  it("prints a dim placeholder line without presigning", async () => {
    const client = fakeClient(async () => {
      throw new Error("should not be called");
    });
    const renderer = new ChatRenderer({ client, images: "auto" });
    const out = captureOutput();

    renderer.handle({
      type: "asset",
      phase: "placeholder",
      data: { type: "image", name: "cat.jpg" },
    });
    await renderer.flushAssets();

    expect(out.text()).toContain("generating");
  });

  it("prints the raw uri immediately when images are disabled", async () => {
    const client = fakeClient(async () => {
      throw new Error("should not be called when images are off");
    });
    const renderer = new ChatRenderer({ client, images: "off" });
    const out = captureOutput();

    renderer.handle({
      type: "asset",
      data: {
        type: "image",
        asset_id: "img_1",
        providers: ["aws"],
        uri: "s3://bucket/img_1.jpg",
      },
    });
    await renderer.flushAssets();

    expect(out.text()).toContain("s3://bucket/img_1.jpg");
  });

  it("resolves non-image asset types the exact same way as images", async () => {
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
    const renderer = new ChatRenderer({ client, images: "auto" });
    const out = captureOutput();

    renderer.handle({
      type: "asset",
      data: {
        type: "video",
        asset_id: "vid_1",
        providers: ["aws"],
        uri: "s3://bucket/vid_1.mp4",
      },
    });
    await renderer.flushAssets();

    expect(out.text()).toContain("https://bucket.s3.example/vid_1.mp4");
  });
});

describe("ChatRenderer guidance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints text from object-form suggested_questions", () => {
    const renderer = new ChatRenderer({ images: "off" });
    const out = captureOutput();

    renderer.handle({
      type: "guidance",
      data: {
        suggested_questions: [
          { text: "开始设计角色/场景视觉" },
          { text: "再调整一下这场戏", action: { type: "send_message" } },
        ],
      },
    });

    const text = out.text();
    expect(text).toContain("Suggested follow-ups:");
    expect(text).toContain("开始设计角色/场景视觉");
    expect(text).toContain("再调整一下这场戏");
    expect(text).not.toContain("[object Object]");
  });

  it("prints legacy string suggested_questions", () => {
    const renderer = new ChatRenderer({ images: "off" });
    const out = captureOutput();

    renderer.handle({
      type: "guidance",
      data: { suggested_questions: ["可以修改角色设定吗？", "如何调整剧本风格？"] },
    });

    const text = out.text();
    expect(text).toContain("可以修改角色设定吗？");
    expect(text).toContain("如何调整剧本风格？");
  });

  it("skips items without a usable label", () => {
    const renderer = new ChatRenderer({ images: "off" });
    const out = captureOutput();

    renderer.handle({
      type: "guidance",
      data: {
        suggested_questions: [{ text: "keep me" }, { action: { type: "fill_input" } }, "", "  "],
      },
    });

    const text = out.text();
    expect(text).toContain("keep me");
    expect(text).not.toContain("[object Object]");
  });
});
