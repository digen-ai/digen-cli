import { describe, expect, it, vi } from "vitest";
import type { DigenClient } from "../src/lib/client.js";
import {
  type InvokableSkill,
  MAX_SKILL_BLOCKS,
  SkillInvoker,
  extractSkillTokens,
  leadingSkillToken,
  matchSkillTokens,
} from "../src/lib/skillsInvoke.js";

const SKILLS: InvokableSkill[] = [
  { id: 1, name: "web_research", displayName: "网络研究", source: "official", enabled: true },
  { id: 2, name: "my-poster", displayName: "海报生成", source: "own", enabled: true },
  { id: 3, name: "paused", displayName: "Paused", source: "own", enabled: false },
];

function fakeClient(payload: unknown): {
  client: DigenClient;
  requestJson: ReturnType<typeof vi.fn>;
} {
  const requestJson = vi.fn(async () => payload);
  return { client: { requestJson } as unknown as DigenClient, requestJson };
}

describe("extractSkillTokens", () => {
  it("finds /name tokens at the start and after whitespace/punctuation", () => {
    expect(extractSkillTokens("/web_research find cats")).toEqual(["web_research"]);
    expect(extractSkillTokens("please use /my-poster, then /web_research.")).toEqual([
      "my-poster",
      "web_research",
    ]);
    expect(extractSkillTokens("用/web_research画图")).toEqual(["web_research"]);
  });

  it("de-duplicates tokens while preserving first-appearance order", () => {
    expect(extractSkillTokens("/a /b /a /c")).toEqual(["a", "b", "c"]);
  });

  it("does not treat URLs, paths, or fractions as invocations", () => {
    expect(extractSkillTokens("see https://example.com/a/b and ./local/path")).toEqual([]);
    expect(extractSkillTokens("a/b is not a token")).toEqual([]);
    expect(extractSkillTokens("ratio 1/2")).toEqual([]);
  });

  it("exposes the leading token separately", () => {
    expect(leadingSkillToken("/web_research hi")).toBe("web_research");
    expect(leadingSkillToken("hi /web_research")).toBeNull();
    expect(leadingSkillToken("/中文")).toBeNull();
  });
});

describe("matchSkillTokens", () => {
  it("builds skill blocks with id and runtime name in invocation order", () => {
    const result = matchSkillTokens(["my-poster", "web_research"], SKILLS);
    expect(result.invoked.map((skill) => skill.name)).toEqual(["my-poster", "web_research"]);
    expect(result.blocks).toEqual([
      { type: "skill", skill_id: 2, name: "my-poster", display_name: "海报生成" },
      { type: "skill", skill_id: 1, name: "web_research", display_name: "网络研究" },
    ]);
    expect(result.unmatched).toEqual([]);
    expect(result.disabled).toEqual([]);
  });

  it("de-duplicates by skill id and caps the number of blocks", () => {
    const skills = Array.from({ length: 4 }, (_, i) => ({
      id: i + 1,
      name: `skill-${i + 1}`,
      enabled: true,
    }));
    const result = matchSkillTokens(
      ["skill-1", "skill-2", "skill-1", "skill-3", "skill-4"],
      skills,
    );
    expect(result.blocks).toHaveLength(MAX_SKILL_BLOCKS);
    expect(result.invoked.map((skill) => skill.name)).toEqual(["skill-1", "skill-2", "skill-3"]);
  });

  it("separates unknown and disabled tokens", () => {
    const result = matchSkillTokens(["nope", "paused", "web_research"], SKILLS);
    expect(result.unmatched).toEqual(["nope"]);
    expect(result.disabled).toEqual(["paused"]);
    expect(result.blocks).toEqual([
      { type: "skill", skill_id: 1, name: "web_research", display_name: "网络研究" },
    ]);
  });
});

describe("SkillInvoker", () => {
  const payload = {
    builtin: [
      { id: 1, name: "web_research", display_name: "网络研究", source: "official" },
      { id: 3, name: "paused", display_name: "Paused", enabled: false },
    ],
    space: [{ id: 2, name: "my-poster", display_name: "海报生成", source: "own" }],
  };

  it("does not hit the API for messages without skill tokens", async () => {
    const { client, requestJson } = fakeClient(payload);
    const invoker = new SkillInvoker(client);
    expect(await invoker.resolve("just a normal message")).toEqual({
      blocks: [],
      invoked: [],
      unmatched: [],
      disabled: [],
    });
    expect(requestJson).not.toHaveBeenCalled();
  });

  it("loads builtin + space skills and caches them", async () => {
    let now = 1_000;
    const { client, requestJson } = fakeClient(payload);
    const invoker = new SkillInvoker(client, 10_000, () => now);

    const first = await invoker.resolve("/my-poster draw a cat");
    expect(first.blocks).toEqual([
      { type: "skill", skill_id: 2, name: "my-poster", display_name: "海报生成" },
    ]);
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(requestJson).toHaveBeenCalledWith("GET", "/api/v1/skills");

    await invoker.resolve("/web_research search");
    expect(requestJson).toHaveBeenCalledTimes(1);

    now += 10_001;
    await invoker.resolve("/web_research search");
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it("refreshes on demand", async () => {
    const { client, requestJson } = fakeClient(payload);
    const invoker = new SkillInvoker(client);
    await invoker.list();
    await invoker.list({ refresh: true });
    expect(requestJson).toHaveBeenCalledTimes(2);
  });
});
