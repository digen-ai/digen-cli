import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DigenClient, GATEWAY_PREFIX } from "../src/lib/client.js";
import { isDirectRun, registerTools } from "../src/mcp/server.js";
import { TaskRegistry } from "../src/mcp/tasks.js";

const BASE_URL = "https://api.example.test";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeClient(): DigenClient {
  return new DigenClient({ apiUrl: BASE_URL, token: "tok_abc", userId: 7, sessionId: "sess_1" });
}

async function connectedMcpClient(digenClient: DigenClient): Promise<Client> {
  const mcpServer = new McpServer({ name: "digen", version: "0.1.0" });
  registerTools(mcpServer, digenClient, new TaskRegistry(digenClient));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);
  return client;
}

function textPayload(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("Expected a text content block");
  }
  return JSON.parse(first.text);
}

async function pollUntilDone(client: Client, taskId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 50; i++) {
    const result = await client.callTool({ name: "digen_poll", arguments: { task_id: taskId } });
    const payload = textPayload(result as never) as Record<string, unknown>;
    if (payload.status !== "running") return payload;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for task ${taskId}`);
}

describe("digen-mcp tools", () => {
  it("lists the registered tools", async () => {
    const client = await connectedMcpClient(makeClient());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "digen_cancel",
      "digen_confirm",
      "digen_history",
      "digen_list_workflows",
      "digen_poll",
      "digen_send",
    ]);
  });

  it("digen_list_workflows returns the workflow list", async () => {
    server.use(
      http.get(`${BASE_URL}${GATEWAY_PREFIX}/public/v1/workflows`, () =>
        HttpResponse.json([{ name: "skill_agent", display_name: "Skill Agent" }]),
      ),
    );
    const client = await connectedMcpClient(makeClient());
    const result = await client.callTool({ name: "digen_list_workflows", arguments: {} });
    expect(textPayload(result as never)).toEqual({
      workflows: [{ name: "skill_agent", display_name: "Skill Agent" }],
    });
  });

  it("digen_send creates a conversation and returns a task_id, then digen_poll returns the aggregated result", async () => {
    server.use(
      http.post(`${BASE_URL}${GATEWAY_PREFIX}/api/v1/conversations`, () =>
        HttpResponse.json(
          { conversation_id: "conv_1", workflow: "skill_agent", status: "pending" },
          { status: 201 },
        ),
      ),
      http.post(`${BASE_URL}${GATEWAY_PREFIX}/api/v1/chat`, () => {
        const body =
          'data: {"sequence":1,"type":"start"}\n\n' +
          'data: {"sequence":2,"type":"chunk","agent":"assistant","content":"Hello!"}\n\n' +
          'data: {"sequence":3,"type":"done"}\n\n';
        return new HttpResponse(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "X-Task-Id": "task_1" },
        });
      }),
    );

    const client = await connectedMcpClient(makeClient());
    const sendResult = await client.callTool({
      name: "digen_send",
      arguments: { message: "hi there", workflow: "skill_agent" },
    });
    expect(textPayload(sendResult as never)).toEqual({
      task_id: "task_1",
      conversation_id: "conv_1",
      status: "running",
    });

    expect(await pollUntilDone(client, "task_1")).toMatchObject({
      status: "done",
      text: "Hello!",
      assets: [],
    });
  });

  it("digen_send reuses an existing conversation_id without creating a new one", async () => {
    let createConversationCalled = false;
    server.use(
      http.post(`${BASE_URL}${GATEWAY_PREFIX}/api/v1/conversations`, () => {
        createConversationCalled = true;
        return HttpResponse.json({ conversation_id: "conv_new", workflow: "skill_agent" });
      }),
      http.post(`${BASE_URL}${GATEWAY_PREFIX}/api/v1/chat`, ({ request }) =>
        request.json().then((body) => {
          expect((body as { conversation_id: string }).conversation_id).toBe("conv_existing");
          return new HttpResponse('data: {"sequence":1,"type":"done"}\n\n', {
            status: 200,
            headers: { "Content-Type": "text/event-stream", "X-Task-Id": "task_2" },
          });
        }),
      ),
    );

    const client = await connectedMcpClient(makeClient());
    const result = await client.callTool({
      name: "digen_send",
      arguments: { message: "continue", conversation_id: "conv_existing" },
    });
    expect(textPayload(result as never)).toMatchObject({ conversation_id: "conv_existing" });
    expect(createConversationCalled).toBe(false);
  });

  it("digen_poll resolves asset URLs via presign for assets carrying an asset_id", async () => {
    server.use(
      http.post(`${BASE_URL}${GATEWAY_PREFIX}/api/v1/conversations`, () =>
        HttpResponse.json({ conversation_id: "conv_1", workflow: "skill_agent" }),
      ),
      http.post(`${BASE_URL}${GATEWAY_PREFIX}/api/v1/chat`, () => {
        const body =
          'data: {"sequence":1,"type":"asset","data":{"type":"image","name":"cat.jpg","asset_id":"img_1","providers":["aws"],"uri":"s3://bucket/cat.jpg"}}\n\n' +
          'data: {"sequence":2,"type":"done"}\n\n';
        return new HttpResponse(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "X-Task-Id": "task_3" },
        });
      }),
      http.post(`${BASE_URL}${GATEWAY_PREFIX}/api/v1/assets/presigned-urls`, () =>
        HttpResponse.json({
          results: [
            {
              asset_id: "img_1",
              urls: { aws: "https://bucket.s3.example/cat.jpg" },
              thumbnail_urls: null,
              error: null,
            },
          ],
          expires_at: "2026-01-01T00:00:00Z",
        }),
      ),
    );

    const client = await connectedMcpClient(makeClient());
    await client.callTool({ name: "digen_send", arguments: { message: "make a cat image" } });
    expect(await pollUntilDone(client, "task_3")).toMatchObject({
      status: "done",
      assets: [{ type: "image", name: "cat.jpg", url: "https://bucket.s3.example/cat.jpg" }],
    });
  });

  it("digen_poll recovers an unknown task_id via getTask + resumeStream", async () => {
    let resumeAfter: string | null = null;
    server.use(
      http.get(`${BASE_URL}${GATEWAY_PREFIX}/api/v1/tasks/task_orphan`, () =>
        HttpResponse.json({ conversation_id: "conv_9", workflow: "skill_agent" }),
      ),
      http.get(`${BASE_URL}${GATEWAY_PREFIX}/api/v1/chat/resume/task_orphan`, ({ request }) => {
        resumeAfter = new URL(request.url).searchParams.get("after_sequence");
        const body =
          'data: {"sequence":1,"type":"chunk","agent":"assistant","content":"recovered"}\n\n' +
          'data: {"sequence":2,"type":"done"}\n\n';
        return new HttpResponse(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );

    const client = await connectedMcpClient(makeClient());
    expect(await pollUntilDone(client, "task_orphan")).toMatchObject({
      status: "done",
      text: "recovered",
    });
    expect(resumeAfter).toBe("0");
  });

  it("digen_confirm calls the countdown endpoint with the requested action", async () => {
    let seenAction: string | undefined;
    server.use(
      http.post(`${BASE_URL}${GATEWAY_PREFIX}/api/v1/tasks/task_4/countdown`, ({ request }) =>
        request.json().then((body) => {
          seenAction = (body as { action: string }).action;
          return new HttpResponse(null, { status: 204 });
        }),
      ),
    );
    const client = await connectedMcpClient(makeClient());
    const result = await client.callTool({
      name: "digen_confirm",
      arguments: { task_id: "task_4", action: "confirm" },
    });
    expect(textPayload(result as never)).toEqual({ ok: true });
    expect(seenAction).toBe("confirm");
  });

  it("digen_cancel calls the task cancel endpoint", async () => {
    let cancelled = false;
    server.use(
      http.delete(`${BASE_URL}${GATEWAY_PREFIX}/api/v1/tasks/task_5`, () => {
        cancelled = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const client = await connectedMcpClient(makeClient());
    const result = await client.callTool({
      name: "digen_cancel",
      arguments: { task_id: "task_5" },
    });
    expect(textPayload(result as never)).toEqual({ ok: true });
    expect(cancelled).toBe(true);
  });

  it("digen_history returns the conversation's message data", async () => {
    server.use(
      http.get(`${BASE_URL}${GATEWAY_PREFIX}/api/v1/conversations/conv_9/messages`, () =>
        HttpResponse.json({
          messages: [{ role: "user", blocks: [{ type: "text", content: "hi" }] }],
        }),
      ),
    );
    const client = await connectedMcpClient(makeClient());
    const result = await client.callTool({
      name: "digen_history",
      arguments: { conversation_id: "conv_9" },
    });
    expect(textPayload(result as never)).toEqual({
      messages: [{ role: "user", blocks: [{ type: "text", content: "hi" }] }],
    });
  });

  it("returns an isError tool result when the API call fails", async () => {
    server.use(
      http.get(`${BASE_URL}${GATEWAY_PREFIX}/public/v1/workflows`, () =>
        HttpResponse.json({ detail: "boom" }, { status: 500 }),
      ),
    );
    const client = await connectedMcpClient(makeClient());
    const result = await client.callTool({ name: "digen_list_workflows", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textPayload(result as never)).toMatchObject({ error: "boom" });
  });
});

describe("isDirectRun", () => {
  it("returns false when argv is missing or does not resolve to this module", () => {
    expect(isDirectRun("")).toBe(false);
    expect(isDirectRun("/nonexistent/path")).toBe(false);
  });
});
