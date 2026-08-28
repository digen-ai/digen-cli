import { describe, expect, it, vi } from "vitest";
import { fetchImageBuffer, isInlineImage, pickUrl } from "../src/lib/assets.js";

describe("isInlineImage", () => {
  it("is true only for the image type", () => {
    expect(isInlineImage("image")).toBe(true);
    expect(isInlineImage("video")).toBe(false);
    expect(isInlineImage("audio")).toBe(false);
    expect(isInlineImage("document")).toBe(false);
    expect(isInlineImage(undefined)).toBe(false);
  });
});

describe("pickUrl", () => {
  it("returns undefined for missing/empty maps", () => {
    expect(pickUrl(undefined)).toBeUndefined();
    expect(pickUrl(null)).toBeUndefined();
    expect(pickUrl({})).toBeUndefined();
  });

  it("prefers the first matching provider in order", () => {
    const urls = { wasabi: "https://wasabi.example/x.jpg", aws: "https://aws.example/x.jpg" };
    expect(pickUrl(urls, ["aws", "wasabi"])).toBe("https://aws.example/x.jpg");
    expect(pickUrl(urls, ["wasabi", "aws"])).toBe("https://wasabi.example/x.jpg");
  });

  it("skips preferred providers that aren't present", () => {
    const urls = { aws: "https://aws.example/x.jpg" };
    expect(pickUrl(urls, ["wasabi", "aws"])).toBe("https://aws.example/x.jpg");
  });

  it("falls back to any available url when no preferred providers match", () => {
    const urls = { aws: "https://aws.example/x.jpg" };
    expect(pickUrl(urls, ["wasabi"])).toBe("https://aws.example/x.jpg");
    expect(pickUrl(urls)).toBe("https://aws.example/x.jpg");
  });
});

describe("fetchImageBuffer", () => {
  it("downloads and concatenates the response body", async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
    let i = 0;
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => {
            if (i < chunks.length) return { done: false, value: chunks[i++] };
            return { done: true, value: undefined };
          },
          releaseLock: () => {},
        }),
      },
    })) as unknown as typeof fetch;

    const buf = await fetchImageBuffer("https://example.test/img.jpg", { fetchImpl });
    expect(Array.from(buf)).toEqual([1, 2, 3, 4]);
  });

  it("throws on a non-OK response", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 404,
      headers: new Headers(),
    })) as unknown as typeof fetch;

    await expect(
      fetchImageBuffer("https://example.test/missing.jpg", { fetchImpl }),
    ).rejects.toThrow(/404/);
  });

  it("rejects when content-length exceeds maxBytes", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      headers: new Headers({ "content-length": "1000" }),
    })) as unknown as typeof fetch;

    await expect(
      fetchImageBuffer("https://example.test/big.jpg", { fetchImpl, maxBytes: 100 }),
    ).rejects.toThrow(/too large/);
  });

  it("rejects when the streamed body exceeds maxBytes", async () => {
    const bigChunk = new Uint8Array(200);
    let served = false;
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => {
            if (!served) {
              served = true;
              return { done: false, value: bigChunk };
            }
            return { done: true, value: undefined };
          },
          releaseLock: () => {},
        }),
      },
    })) as unknown as typeof fetch;

    await expect(
      fetchImageBuffer("https://example.test/big.jpg", { fetchImpl, maxBytes: 100 }),
    ).rejects.toThrow(/too large/);
  });
});
