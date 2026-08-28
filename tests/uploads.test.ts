import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DigenClient, UploadPresignResponse, UploadedAsset } from "../src/lib/client.js";
import {
  buildMessageBlocks,
  formatBytes,
  imageContentTypeForPath,
  stageImage,
  uploadImageFile,
} from "../src/lib/uploads.js";

describe("imageContentTypeForPath", () => {
  it("maps supported image extensions to their MIME type", () => {
    expect(imageContentTypeForPath("photo.jpg")).toBe("image/jpeg");
    expect(imageContentTypeForPath("photo.JPEG")).toBe("image/jpeg");
    expect(imageContentTypeForPath("photo.png")).toBe("image/png");
    expect(imageContentTypeForPath("photo.gif")).toBe("image/gif");
    expect(imageContentTypeForPath("photo.webp")).toBe("image/webp");
  });

  it("returns null for unsupported or missing extensions", () => {
    expect(imageContentTypeForPath("document.pdf")).toBeNull();
    expect(imageContentTypeForPath("video.mp4")).toBeNull();
    expect(imageContentTypeForPath("noext")).toBeNull();
  });
});

describe("formatBytes", () => {
  it("formats bytes, KB, MB with sensible precision", () => {
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(15 * 1024)).toBe("15 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("stageImage", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "digen-upload-test-"));
  });

  it("stages an existing image file", () => {
    const path = join(dir, "cat.jpg");
    writeFileSync(path, Buffer.from([1, 2, 3, 4]));

    const staged = stageImage(path);
    expect(staged.name).toBe("cat.jpg");
    expect(staged.size).toBe(4);
    expect(staged.contentType).toBe("image/jpeg");
  });

  it("strips surrounding quotes and expands ~ paths are resolved as absolute", () => {
    const path = join(dir, "dog.png");
    writeFileSync(path, Buffer.from([1]));

    const staged = stageImage(`"${path}"`);
    expect(staged.path).toBe(path);
  });

  it("rejects unsupported file types", () => {
    const path = join(dir, "notes.pdf");
    writeFileSync(path, Buffer.from([1]));
    expect(() => stageImage(path)).toThrow(/Unsupported file type/);
  });

  it("rejects missing files", () => {
    expect(() => stageImage(join(dir, "missing.jpg"))).toThrow(/not found/);
  });

  it("rejects an empty path", () => {
    expect(() => stageImage("   ")).toThrow(/Usage: \/attach/);
  });
});

describe("uploadImageFile", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "digen-upload-test-"));
    path = join(dir, "cat.jpg");
    writeFileSync(path, Buffer.from([1, 2, 3, 4]));
  });

  function fakeClient(opts?: {
    maxSize?: number;
    presign?: Partial<UploadPresignResponse>;
    asset?: Partial<UploadedAsset>;
  }): DigenClient {
    const presignUpload = vi.fn(
      async (): Promise<UploadPresignResponse> => ({
        upload_url: "https://s3.example.test/upload",
        final_url: "https://bucket.s3.example.test/uploads/cat.jpg",
        key: "1/uploads/2026-01-01/cat.jpg",
        max_size: opts?.maxSize ?? 1024,
        ...opts?.presign,
      }),
    );
    const uploadToPresignedUrl = vi.fn(async () => {});
    const registerUploadedAsset = vi.fn(
      async (): Promise<UploadedAsset> => ({
        asset_id: "upl_abc123",
        uri: "s3://bucket/uploads/cat.jpg",
        type: "image",
        source: "user_upload",
        providers: ["aws"],
        parsing_status: null,
        ...opts?.asset,
      }),
    );
    return {
      presignUpload,
      uploadToPresignedUrl,
      registerUploadedAsset,
    } as unknown as DigenClient;
  }

  it("presigns, uploads, registers, and returns an image chat block", async () => {
    const client = fakeClient();
    const staged = stageImage(path);

    const block = await uploadImageFile(client, "conv_1", staged);

    expect(client.presignUpload).toHaveBeenCalledWith("conv_1", {
      filename: "cat.jpg",
      contentType: "image/jpeg",
    });
    expect(client.uploadToPresignedUrl).toHaveBeenCalledWith(
      "https://s3.example.test/upload",
      expect.any(Buffer),
      "image/jpeg",
    );
    expect(client.registerUploadedAsset).toHaveBeenCalledWith("conv_1", {
      url: "https://bucket.s3.example.test/uploads/cat.jpg",
      assetType: "image",
      contentType: "image/jpeg",
      filename: "cat.jpg",
    });
    expect(block).toEqual({
      type: "image",
      uri: "s3://bucket/uploads/cat.jpg",
      providers: ["aws"],
      source: "user_upload",
      asset_id: "upl_abc123",
      name: "cat.jpg",
    });
  });

  it("rejects a file larger than the presigned max_size without uploading", async () => {
    const client = fakeClient({ maxSize: 1 });
    const staged = stageImage(path);

    await expect(uploadImageFile(client, "conv_1", staged)).rejects.toThrow(/too large/);
    expect(client.uploadToPresignedUrl).not.toHaveBeenCalled();
    expect(client.registerUploadedAsset).not.toHaveBeenCalled();
  });
});

describe("buildMessageBlocks", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "digen-upload-test-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function fakeClient(): DigenClient {
    return {
      presignUpload: vi.fn(async () => ({
        upload_url: "https://s3.example.test/upload",
        final_url: "https://bucket.s3.example.test/uploads/x.jpg",
        key: "k",
        max_size: 1024,
      })),
      uploadToPresignedUrl: vi.fn(async () => {}),
      registerUploadedAsset: vi.fn(async () => ({
        asset_id: "upl_1",
        uri: "s3://bucket/x.jpg",
        type: "image",
        source: "user_upload",
        providers: ["aws"],
        parsing_status: null,
      })),
    } as unknown as DigenClient;
  }

  it("uploads staged images in order, then appends the text block", async () => {
    const client = fakeClient();
    const a = stageImage(
      (() => {
        const p = join(dir, "a.jpg");
        writeFileSync(p, Buffer.from([1]));
        return p;
      })(),
    );
    const b = stageImage(
      (() => {
        const p = join(dir, "b.png");
        writeFileSync(p, Buffer.from([1]));
        return p;
      })(),
    );

    const progress: number[] = [];
    const blocks = await buildMessageBlocks(client, "conv_1", [a, b], "hello", (_img, index) => {
      progress.push(index);
    });

    expect(progress).toEqual([0, 1]);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ type: "image", name: "a.jpg" });
    expect(blocks[1]).toMatchObject({ type: "image", name: "b.png" });
    expect(blocks[2]).toEqual({ type: "text", content: "hello" });
  });

  it("omits the text block entirely when text is empty", async () => {
    const client = fakeClient();
    const p = join(dir, "a.jpg");
    writeFileSync(p, Buffer.from([1]));
    const a = stageImage(p);

    const blocks = await buildMessageBlocks(client, "conv_1", [a], "   ");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "image" });
  });

  it("returns just the text block when nothing is staged", async () => {
    const client = fakeClient();
    const blocks = await buildMessageBlocks(client, "conv_1", [], "hi");
    expect(blocks).toEqual([{ type: "text", content: "hi" }]);
  });
});
