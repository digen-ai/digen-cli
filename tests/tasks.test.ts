import { describe, expect, it, vi } from "vitest";
import type { DigenClient } from "../src/lib/client.js";
import type { ChatEvent } from "../src/lib/sse.js";
import { TaskRegistry } from "../src/mcp/tasks.js";

async function* eventsOf(items: ChatEvent[]): AsyncGenerator<ChatEvent> {
  for (const item of items) yield item;
}

async function* failingStream(items: ChatEvent[], error: Error): AsyncGenerator<ChatEvent> {
  for (const item of items) yield item;
  throw error;
}

function fakeClient(overrides: Partial<DigenClient>): DigenClient {
  return overrides as DigenClient;
}

describe("TaskRegistry", () => {
  it("resumes the SSE stream from the next sequence after a disconnect", async () => {
    const resumeStream = vi.fn(async (_taskId: string, afterSequence: number) => {
      expect(afterSequence).toBe(2);
      return eventsOf([
        { sequence: 2, type: "chunk", agent: "assistant", content: "lo" },
        { sequence: 3, type: "done" },
      ]);
    });
    const client = fakeClient({
      createConversation: async () => ({ conversation_id: "conv_1", workflow: "skill_agent" }),
      chatStream: async () => ({
        taskId: "task_1",
        events: failingStream(
          [{ sequence: 1, type: "chunk", agent: "assistant", content: "Hel" }],
          new Error("socket hang up"),
        ),
      }),
      resumeStream,
    });

    const registry = new TaskRegistry(client, { resumeDelayMs: () => 0 });
    const { taskId } = await registry.send({ message: "hi", workflow: "skill_agent" });
    await registry.get(taskId)?.done;

    const snapshot = await registry.poll(taskId);
    expect(snapshot).toMatchObject({ status: "done", text: "Hello" });
    expect(resumeStream).toHaveBeenCalledOnce();
  });

  it("rebuilds an unknown task from getTask + resumeStream (e.g. after a restart)", async () => {
    const client = fakeClient({
      getTask: async (taskId: string) => {
        expect(taskId).toBe("task_orphan");
        return { conversation_id: "conv_9", workflow: "skill_agent" };
      },
      resumeStream: async (taskId: string, afterSequence: number) => {
        expect(taskId).toBe("task_orphan");
        expect(afterSequence).toBe(0);
        return eventsOf([
          { sequence: 1, type: "chunk", agent: "assistant", content: "recovered" },
          { sequence: 2, type: "done" },
        ]);
      },
    });

    const registry = new TaskRegistry(client);
    const first = await registry.poll("task_orphan");
    expect(first.status).toBe("running");

    await registry.get("task_orphan")?.done;
    const snapshot = await registry.poll("task_orphan");
    expect(snapshot).toMatchObject({ status: "done", text: "recovered" });
  });

  it("marks a still-running turn as done when the stream closes without a terminal event", async () => {
    const client = fakeClient({
      createConversation: async () => ({ conversation_id: "conv_1", workflow: "skill_agent" }),
      chatStream: async () => ({
        taskId: "task_quiet",
        events: eventsOf([{ sequence: 1, type: "chunk", agent: "assistant", content: "partial" }]),
      }),
    });

    const registry = new TaskRegistry(client);
    const { taskId } = await registry.send({ message: "hi", workflow: "skill_agent" });
    await registry.get(taskId)?.done;
    expect(await registry.poll(taskId)).toMatchObject({ status: "done", text: "partial" });
  });
});
