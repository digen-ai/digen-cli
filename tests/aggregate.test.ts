import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../src/lib/sse.js";
import { TurnAggregator } from "../src/mcp/aggregate.js";

function feed(events: ChatEvent[]): TurnAggregator {
  const agg = new TurnAggregator();
  for (const event of events) agg.handle(event);
  return agg;
}

describe("TurnAggregator", () => {
  it("concatenates chunk content from the same agent", () => {
    const agg = feed([
      { type: "start" },
      { type: "chunk", agent: "assistant", content: "Hello, " },
      { type: "chunk", agent: "assistant", content: "world!" },
      { type: "done" },
    ]);
    expect(agg.result()).toMatchObject({ status: "done", text: "Hello, world!" });
  });

  it("separates chunks from different agents with a blank line", () => {
    const agg = feed([
      { type: "chunk", agent: "orchestrator", content: "planning…" },
      { type: "chunk", agent: "writer", content: "the final text" },
      { type: "done" },
    ]);
    expect(agg.result().text).toBe("planning…\n\nthe final text");
  });

  it("collects asset events, skipping placeholders", () => {
    const agg = feed([
      { type: "asset", phase: "placeholder", data: { type: "image", name: "cat.jpg" } },
      {
        type: "asset",
        data: {
          type: "image",
          name: "cat.jpg",
          asset_id: "img_1",
          providers: ["aws"],
          uri: "s3://bucket/cat.jpg",
        },
      },
      { type: "done" },
    ]);
    const { assets } = agg.result();
    expect(assets).toEqual([
      {
        type: "image",
        name: "cat.jpg",
        url: undefined,
        uri: "s3://bucket/cat.jpg",
        assetId: "img_1",
        providers: ["aws"],
      },
    ]);
  });

  it("reports await_confirmation status with confirmation type", () => {
    const agg = feed([
      { type: "chunk", agent: "assistant", content: "Should I proceed?" },
      { type: "await_confirmation", data: { confirmation_type: "destructive_action" } },
    ]);
    expect(agg.result()).toMatchObject({
      status: "await_confirmation",
      confirmationType: "destructive_action",
    });
  });

  it("reports error status with the error message", () => {
    const agg = feed([{ type: "error", content: "Something went wrong" }]);
    expect(agg.result()).toMatchObject({ status: "error", errorMessage: "Something went wrong" });
  });

  it("stays running until an explicit done/error/await_confirmation event", () => {
    const agg = feed([{ type: "start" }, { type: "chunk", agent: "assistant", content: "hi" }]);
    expect(agg.result().status).toBe("running");
  });

  it("collects suggested follow-up questions from guidance events", () => {
    const agg = feed([
      {
        type: "guidance",
        data: { suggested_questions: ["What next?", { text: "Try another workflow" }, ""] },
      },
      { type: "done" },
    ]);
    expect(agg.result().suggestedQuestions).toEqual(["What next?", "Try another workflow"]);
  });

  it("tracks the last sequence number seen", () => {
    const agg = feed([
      { type: "start", sequence: 1 },
      { type: "chunk", agent: "assistant", content: "hi", sequence: 2 },
      { type: "done", sequence: 3 },
    ]);
    expect(agg.result().lastSequence).toBe(3);
  });

  it("reports cancelled status from countdown_cancelled", () => {
    const agg = feed([{ type: "countdown_cancelled" }]);
    expect(agg.result().status).toBe("cancelled");
  });

  it("resumes running after await_confirmation once the countdown completes", () => {
    const agg = feed([
      { type: "await_confirmation", data: { confirmation_type: "destructive_action" } },
      { type: "countdown_done" },
      { type: "chunk", agent: "assistant", content: "continuing" },
    ]);
    expect(agg.result()).toMatchObject({ status: "running", text: "continuing" });
    expect(agg.result().confirmationType).toBeUndefined();
  });

  it("completeIfRunning marks a still-running turn as done, but leaves paused/terminal states", () => {
    const running = feed([{ type: "chunk", agent: "assistant", content: "hi" }]);
    running.completeIfRunning();
    expect(running.result().status).toBe("done");

    const paused = feed([{ type: "await_confirmation" }]);
    paused.completeIfRunning();
    expect(paused.result().status).toBe("await_confirmation");

    const errored = feed([{ type: "error", content: "nope" }]);
    errored.completeIfRunning();
    expect(errored.result().status).toBe("error");
  });
});
