/**
 * `/skill-name` invocation for chat messages.
 *
 * Users can type `/name` tokens (the skill's runtime `name`, not its market
 * `slug`) anywhere in a message. Each resolved token becomes a
 * `{type: "skill", skill_id, name, display_name?}` block next to the text
 * block; the text itself is sent verbatim, including the `/name` token, as
 * required by the API (`docs/API_REFERENCE.md` §1 "skill 内容块").
 *
 * The backend caps explicit invocations at 3 per message, keeps invocation
 * order, and de-duplicates by skill id — we mirror that locally so the user
 * sees the same result as the web client.
 */

import type { ChatBlock, DigenClient } from "./client.js";
import { SkillsApi } from "./skillsApi.js";

export const MAX_SKILL_BLOCKS = 3;

export interface InvokableSkill {
  id: number;
  /** Runtime identifier used by `/name` (SKILL.md `name`), never the slug. */
  name: string;
  displayName?: string;
  /** Official builtin vs. a member of the user's space. */
  source?: string;
  /** Disabled skills stay listed but cannot be invoked until re-enabled. */
  enabled: boolean;
}

export interface ResolvedSkillInvocation {
  /** Skill blocks to insert into the outgoing message, in invocation order. */
  blocks: ChatBlock[];
  invoked: InvokableSkill[];
  /** `/name` tokens with no matching skill; they stay in the text verbatim. */
  unmatched: string[];
  /** `/name` tokens that matched a disabled skill. */
  disabled: string[];
}

const EMPTY_INVOCATION: ResolvedSkillInvocation = {
  blocks: [],
  invoked: [],
  unmatched: [],
  disabled: [],
};

// A `/name` token is not preceded by a word character, another slash, a
// colon, or a dot, so `https://…`, `a/b`, and `./script` are not invocations.
// CJK text before the token (`用/skill 画图`) is allowed.
const SKILL_TOKEN_RE = /(?<![\w:/.-])\/([A-Za-z0-9][A-Za-z0-9_-]*)/g;

/** Unique `/name` tokens in first-appearance order. */
export function extractSkillTokens(text: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const match of text.matchAll(SKILL_TOKEN_RE)) {
    const name = match[1];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** The `/name` token at the very start of the input, if any. */
export function leadingSkillToken(text: string): string | null {
  return /^\/([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(text)?.[1] ?? null;
}

function toInvokableSkill(raw: unknown): InvokableSkill | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "number" ? record.id : Number(record.id);
  const name = typeof record.name === "string" ? record.name : "";
  if (!Number.isInteger(id) || !name) return null;
  return {
    id,
    name,
    displayName: typeof record.display_name === "string" ? record.display_name : undefined,
    source: typeof record.source === "string" ? record.source : undefined,
    enabled: record.enabled !== false,
  };
}

/** Resolve token names against the skill list (order-preserving, de-duped, capped). */
export function matchSkillTokens(
  names: string[],
  skills: InvokableSkill[],
): ResolvedSkillInvocation {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const invoked: InvokableSkill[] = [];
  const unmatched: string[] = [];
  const disabled: string[] = [];

  for (const name of names) {
    const skill = byName.get(name);
    if (!skill) {
      unmatched.push(name);
      continue;
    }
    if (!skill.enabled) {
      disabled.push(name);
      continue;
    }
    if (invoked.some((existing) => existing.id === skill.id)) continue;
    if (invoked.length >= MAX_SKILL_BLOCKS) continue;
    invoked.push(skill);
  }

  return {
    blocks: invoked.map((skill) => ({
      type: "skill",
      skill_id: skill.id,
      name: skill.name,
      ...(skill.displayName ? { display_name: skill.displayName } : {}),
    })),
    invoked,
    unmatched,
    disabled,
  };
}

/**
 * Loads the user's invokable skills (`GET /api/v1/skills`) and resolves
 * `/name` tokens. The list is cached briefly so plain messages never hit the
 * API and repeated invocations don't refetch on every turn.
 */
export class SkillInvoker {
  private cached: InvokableSkill[] | null = null;
  private loadedAt = 0;

  constructor(
    private client: DigenClient,
    private ttlMs = 30_000,
    private now: () => number = () => Date.now(),
  ) {}

  async list(opts?: { refresh?: boolean }): Promise<InvokableSkill[]> {
    const stale = this.now() - this.loadedAt > this.ttlMs;
    if (opts?.refresh || !this.cached || stale) {
      const data = await new SkillsApi(this.client).list();
      const builtin = Array.isArray(data.builtin) ? data.builtin : [];
      const space = Array.isArray(data.space) ? data.space : [];
      this.cached = [...builtin, ...space]
        .map(toInvokableSkill)
        .filter((skill): skill is InvokableSkill => skill !== null);
      this.loadedAt = this.now();
    }
    return this.cached;
  }

  async resolve(text: string): Promise<ResolvedSkillInvocation> {
    const names = extractSkillTokens(text);
    if (names.length === 0) return EMPTY_INVOCATION;
    return matchSkillTokens(names, await this.list());
  }
}
