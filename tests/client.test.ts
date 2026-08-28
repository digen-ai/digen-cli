import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DigenClient, GATEWAY_PREFIX } from "../src/lib/client.js";

const BASE_URL = "https://api.example.test";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeClient(): DigenClient {
  return new DigenClient({
    apiUrl: BASE_URL,
    token: "tok_abc",
    userId: 7,
    sessionId: "sess_1",
  });
}

describe("DigenClient", () => {
  it("sends the composed digen-token and digen-sessionid headers", async () => {
    let seenHeaders: Headers | undefined;
    server.use(
      http.get(`${BASE_URL}${GATEWAY_PREFIX}/public/v1/workflows`, ({ request }) => {
        seenHeaders = request.headers;
        return HttpResponse.json([{ name: "skill_agent" }]);
      }),
    );
    const client = makeClient();
    const workflows = await client.listWorkflows();
    expect(workflows).toEqual([{ name: "skill_agent" }]);
    expect(seenHeaders?.get("digen-token")).toMatch(/^tok_abc:7:\d+$/);
    expect(seenHeaders?.get("digen-sessionid")).toBe("sess_1");
  });

  it("creates a conversation with the workflow query param", async () => {
    server.use(
      http.post(`${BASE_URL}${GATEWAY_PREFIX}/api/v1/conversations`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("workflow")).toBe("skill_agent");
        return HttpResponse.json(
          { conversation_id: "conv_1", workflow: "skill_agent", status: "pending" },
          { status: 201 },
        );
      }),
    );
    const client = makeClient();
    const conv = await client.createConversation("skill_agent");
    expect(conv.conversation_id).toBe("conv_1");
  });

  it("throws ApiError with structured detail on CONVERSATION_BUSY (409)", async () => {
    server.use(
      http.post(`${BASE_URL}${GATEWAY_PREFIX}/api/v1/chat`, () =>
        HttpResponse.json(
          {
            error: "HTTPException",
            message: {
              code: "CONVERSATION_BUSY",
              message: "A task is already running for this conversation",
              existing_task_ids: ["task_1"],
              limit: 1,
            },
            detail: null,
          },
          { status: 409 },
        ),
      ),
    );
    const client = makeClient();
    await expect(
      client.chatStream({
        blocks: [{ type: "text", content: "hi" }],
        conversationId: "conv_1",
        workflow: "skill_agent",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      structured: { code: "CONVERSATION_BUSY" },
    });
  });

  it("streams SSE chat events and exposes the X-Task-Id header", async () => {
    server.use(
      http.post(`${BASE_URL}${GATEWAY_PREFIX}/api/v1/chat`, () => {
        const body =
          'data: {"sequence":1,"type":"start"}\n\ndata: {"sequence":2,"type":"done"}\n\n';
        return new HttpResponse(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "X-Task-Id": "task_xyz" },
        });
      }),
    );
    const client = makeClient();
    const { taskId, events } = await client.chatStream({
      blocks: [{ type: "text", content: "hi" }],
      conversationId: "conv_1",
      workflow: "skill_agent",
    });
    expect(taskId).toBe("task_xyz");
    const seen = [];
    for await (const event of events) seen.push(event);
    expect(seen).toEqual([
      { sequence: 1, type: "start" },
      { sequence: 2, type: "done" },
    ]);
  });

  it("fetches presigned urls for a batch of assets, passing through per-item errors", async () => {
    server.use(
      http.post(
        `${BASE_URL}${GATEWAY_PREFIX}/api/v1/assets/presigned-urls`,
        async ({ request }) => {
          const body = (await request.json()) as { items: Array<{ asset_id: string }> };
          expect(body.items).toEqual([
            { asset_id: "img_1", providers: ["aws"], thumbnail_providers: ["aws"] },
            { asset_id: "img_2", providers: ["aws"] },
          ]);
          return HttpResponse.json({
            results: [
              {
                asset_id: "img_1",
                urls: { aws: "https://bucket.s3.example/img_1.jpg" },
                thumbnail_urls: { aws: "https://bucket.s3.example/img_1_thumb.jpg" },
                error: null,
              },
              {
                asset_id: "img_2",
                urls: {},
                thumbnail_urls: null,
                error: "Access denied to asset: img_2",
              },
            ],
            expires_at: "2026-02-06T13:00:00Z",
          });
        },
      ),
    );
    const client = makeClient();
    const res = await client.getPresignedUrls([
      { asset_id: "img_1", providers: ["aws"], thumbnail_providers: ["aws"] },
      { asset_id: "img_2", providers: ["aws"] },
    ]);
    expect(res.results[0]?.urls.aws).toBe("https://bucket.s3.example/img_1.jpg");
    expect(res.results[1]?.error).toBe("Access denied to asset: img_2");
  });

  it("presigns an upload with the conversation_id query param and filename/content_type body", async () => {
    server.use(
      http.post(`${BASE_URL}${GATEWAY_PREFIX}/api/v1/upload/presign`, async ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("conversation_id")).toBe("conv_1");
        const body = await request.json();
        expect(body).toEqual({ filename: "cat.jpg", content_type: "image/jpeg" });
        return HttpResponse.json({
          upload_url: "https://s3.example.test/upload-target",
          final_url: "https://bucket.s3.example.test/uploads/cat.jpg",
          key: "1/uploads/2026-01-01/cat.jpg",
          max_size: 10485760,
        });
      }),
    );
    const client = makeClient();
    const res = await client.presignUpload("conv_1", {
      filename: "cat.jpg",
      contentType: "image/jpeg",
    });
    expect(res.upload_url).toBe("https://s3.example.test/upload-target");
    expect(res.max_size).toBe(10485760);
  });

  it("registers an uploaded asset via the gateway", async () => {
    server.use(
      http.post(
        `${BASE_URL}${GATEWAY_PREFIX}/api/v1/conversations/conv_1/assets/upload`,
        async ({ request }) => {
          const body = await request.json();
          expect(body).toEqual({
            url: "https://bucket.s3.example.test/uploads/cat.jpg",
            asset_type: "image",
            content_type: "image/jpeg",
            filename: "cat.jpg",
          });
          return HttpResponse.json({
            asset_id: "upl_abc123",
            uri: "s3://bucket/uploads/cat.jpg",
            type: "image",
            source: "user_upload",
            providers: ["aws"],
            parsing_status: null,
          });
        },
      ),
    );
    const client = makeClient();
    const asset = await client.registerUploadedAsset("conv_1", {
      url: "https://bucket.s3.example.test/uploads/cat.jpg",
      assetType: "image",
      contentType: "image/jpeg",
      filename: "cat.jpg",
    });
    expect(asset.asset_id).toBe("upl_abc123");
    expect(asset.providers).toEqual(["aws"]);
  });

  it("PUTs to the presigned S3 URL with only Content-Type and x-amz-acl, no gateway headers", async () => {
    let seenHeaders: Headers | undefined;
    let seenMethod: string | undefined;
    server.use(
      http.put("https://s3.example.test/upload-target", async ({ request }) => {
        seenHeaders = request.headers;
        seenMethod = request.method;
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const client = makeClient();
    await client.uploadToPresignedUrl(
      "https://s3.example.test/upload-target",
      Buffer.from([1, 2, 3]),
      "image/jpeg",
    );
    expect(seenMethod).toBe("PUT");
    expect(seenHeaders?.get("content-type")).toBe("image/jpeg");
    expect(seenHeaders?.get("x-amz-acl")).toBe("public-read");
    expect(seenHeaders?.get("digen-token")).toBeNull();
    expect(seenHeaders?.get("digen-sessionid")).toBeNull();
  });

  it("throws an ApiError when the S3 PUT is rejected", async () => {
    server.use(
      http.put(
        "https://s3.example.test/upload-target",
        () => new HttpResponse(null, { status: 403 }),
      ),
    );
    const client = makeClient();
    await expect(
      client.uploadToPresignedUrl(
        "https://s3.example.test/upload-target",
        Buffer.from([1]),
        "image/jpeg",
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("raises a plain ApiError for a 404 with a FastAPI-style detail body", async () => {
    server.use(
      http.get(`${BASE_URL}${GATEWAY_PREFIX}/api/v1/conversations/missing`, () =>
        HttpResponse.json({ detail: "Conversation not found" }, { status: 404 }),
      ),
    );
    const client = makeClient();
    await expect(client.getConversation("missing")).rejects.toThrow("Conversation not found");
  });
});
