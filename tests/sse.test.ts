import { describe, expect, it } from "vitest";
import { parseChatEvents } from "../src/lib/sse.js";

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("parseChatEvents", () => {
  it("parses a sequence of data: events", async () => {
    const body = streamFrom([
      'data: {"sequence":1,"type":"start"}\n\n',
      'data: {"sequence":2,"type":"chunk","agent":"writer","content":"hello"}\n\n',
      'data: {"sequence":3,"type":"done"}\n\n',
    ]);
    const events = [];
    for await (const event of parseChatEvents(body)) events.push(event);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: "start", sequence: 1 });
    expect(events[1]).toMatchObject({ type: "chunk", agent: "writer", content: "hello" });
    expect(events[2]).toMatchObject({ type: "done", sequence: 3 });
  });

  it("handles events split across multiple stream chunks", async () => {
    const body = streamFrom(['data: {"sequence":1,"type":"chu', 'nk","content":"ab"}\n\n']);
    const events = [];
    for await (const event of parseChatEvents(body)) events.push(event);
    expect(events).toEqual([{ sequence: 1, type: "chunk", content: "ab" }]);
  });

  it("skips malformed JSON payloads without throwing", async () => {
    const body = streamFrom(["data: not-json\n\n", 'data: {"sequence":2,"type":"done"}\n\n']);
    const events = [];
    for await (const event of parseChatEvents(body)) events.push(event);
    expect(events).toEqual([{ sequence: 2, type: "done" }]);
  });

  it("ignores heartbeat comments", async () => {
    const body = streamFrom([": heartbeat\n\n", 'data: {"sequence":1,"type":"done"}\n\n']);
    const events = [];
    for await (const event of parseChatEvents(body)) events.push(event);
    expect(events).toEqual([{ sequence: 1, type: "done" }]);
  });
});
