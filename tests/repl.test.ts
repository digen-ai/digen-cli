import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { DigenClient } from "../src/lib/client.js";
import { runChatRepl } from "../src/ui/repl.js";

function doneEvents() {
  return (async function* () {
    yield { type: "done", sequence: 1 };
  })();
}

describe("runChatRepl opening message", () => {
  it("sends the opening message before reading further input", async () => {
    const chatStream = vi.fn(async () => ({ taskId: "task_1", events: doneEvents() }));
    const client = { chatStream } as unknown as DigenClient;
    const input = new PassThrough();
    const done = runChatRepl({
      client,
      conversationId: "conv_1",
      workflow: "skill_agent",
      images: "off",
      message: "帮我做个海报",
      input,
    });

    await vi.waitFor(() => {
      expect(chatStream).toHaveBeenCalledTimes(1);
    });
    input.end();
    await done;

    expect(chatStream).toHaveBeenCalledWith({
      blocks: [{ type: "text", content: "帮我做个海报" }],
      conversationId: "conv_1",
      workflow: "skill_agent",
      signal: expect.any(AbortSignal),
    });
  });

  it("reads the next line after the opening message", async () => {
    const chatStream = vi.fn(async () => ({ taskId: "task_1", events: doneEvents() }));
    const client = { chatStream } as unknown as DigenClient;
    const input = new PassThrough();
    const done = runChatRepl({
      client,
      conversationId: "conv_1",
      workflow: "skill_agent",
      images: "off",
      message: "第一句",
      input,
    });

    await vi.waitFor(() => {
      expect(chatStream).toHaveBeenCalledTimes(1);
    });
    input.write("第二句\n");
    await vi.waitFor(() => {
      expect(chatStream).toHaveBeenCalledTimes(2);
    });
    input.end();
    await done;

    expect(chatStream).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        blocks: [{ type: "text", content: "第二句" }],
      }),
    );
  });

  it("does not send anything when no opening message is given", async () => {
    const chatStream = vi.fn();
    const client = { chatStream } as unknown as DigenClient;
    const input = new PassThrough();
    const done = runChatRepl({
      client,
      conversationId: "conv_1",
      workflow: "skill_agent",
      images: "off",
      input,
    });
    input.end();
    await done;
    expect(chatStream).not.toHaveBeenCalled();
  });
});
