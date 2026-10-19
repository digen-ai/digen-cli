/**
 * Local skill workspace helpers: SKILL.md <-> API fields and reference files.
 *
 * Mirrors the Python `digenskill` implementation and the server-side loader
 * closely enough that packed skills round-trip through `/api/v1/skills`.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import yaml from "js-yaml";

export const SKILL_FILENAME = "SKILL.md";

const SKIP_DIR_NAMES = new Set([".git", "__pycache__", "scripts", ".venv"]);
const SKIP_EXTENSIONS = new Set([
  ".pyc",
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".bin",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".mp4",
  ".mp3",
  ".zip",
  ".tar",
  ".gz",
]);

export interface SkillFields {
  name: string;
  description: string;
  display_name?: string | null;
  allowed_tools: string[];
  body: string;
  metadata: Record<string, unknown>;
}

function splitFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const withoutBom = text.replace(/^\uFEFF/, "");
  if (!withoutBom.startsWith("---")) return { frontmatter: {}, body: withoutBom };
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(withoutBom);
  if (!match) return { frontmatter: {}, body: withoutBom };
  const raw = match[1] ?? "";
  const body = match[2] ?? "";
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(`failed to parse SKILL.md frontmatter YAML: ${String(err)}`);
  }
  if (parsed === null || parsed === undefined) return { frontmatter: {}, body };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SKILL.md frontmatter must be a YAML mapping");
  }
  return { frontmatter: parsed as Record<string, unknown>, body };
}

export function parseSkillMd(text: string, opts?: { defaultName?: string | null }): SkillFields {
  const { frontmatter, body } = splitFrontmatter(text);
  const {
    name: fmName,
    description: fmDescription,
    display_name: fmDisplayName,
    title: fmTitle,
    "allowed-tools": fmAllowedToolsDash,
    allowed_tools: fmAllowedToolsUnderscore,
    ...metadata
  } = frontmatter;
  const name = (fmName as string | undefined) ?? opts?.defaultName ?? null;
  if (!name) {
    throw new Error("SKILL.md is missing name (neither frontmatter nor directory name provided)");
  }
  const description = (fmDescription as string | undefined) ?? "";
  const displayName =
    (fmDisplayName as string | undefined) ?? (fmTitle as string | undefined) ?? null;
  let allowedTools: unknown = fmAllowedToolsDash ?? fmAllowedToolsUnderscore ?? [];
  if (typeof allowedTools === "string") {
    allowedTools = allowedTools
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return {
    name: String(name),
    description: String(description),
    display_name: displayName,
    allowed_tools: Array.isArray(allowedTools) ? allowedTools.map(String) : [],
    body: body.trim(),
    metadata,
  };
}

export function buildSkillMd(skill: {
  name?: string;
  description?: string;
  display_name?: string | null;
  allowed_tools?: string[] | null;
  metadata?: Record<string, unknown> | null;
  body?: string | null;
}): string {
  const fm: Record<string, unknown> = { name: skill.name ?? "" };
  if (skill.display_name) fm.display_name = skill.display_name;
  fm.description = skill.description ?? "";
  if (skill.allowed_tools && skill.allowed_tools.length > 0) {
    fm["allowed-tools"] = [...skill.allowed_tools];
  }
  for (const [key, value] of Object.entries(skill.metadata ?? {})) {
    if (
      ["name", "description", "display_name", "title", "allowed-tools", "allowed_tools"].includes(
        key,
      )
    ) {
      continue;
    }
    fm[key] = value;
  }
  const frontmatter = yaml.dump(fm, { lineWidth: -1, noRefs: true }).trimEnd();
  const body = (skill.body ?? "").trim();
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

export function shouldSkipRel(relParts: string[]): boolean {
  if (relParts.length === 0) return true;
  for (const part of relParts.slice(0, -1)) {
    if (SKIP_DIR_NAMES.has(part) || part.startsWith(".")) return true;
  }
  const name = relParts[relParts.length - 1] ?? "";
  if (name.startsWith(".") && name !== SKILL_FILENAME) return true;
  const dot = name.lastIndexOf(".");
  const suffix = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return SKIP_EXTENSIONS.has(suffix);
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  };
  visit(root);
  return out;
}

export function collectReferenceFiles(path: string): Record<string, string> {
  const root = resolve(path);
  const refs: Record<string, string> = {};
  for (const file of walkFiles(root)) {
    const relPath = relative(root, file);
    const parts = relPath.split(/[\\/]/);
    if (parts.length === 1 && parts[0] === SKILL_FILENAME) continue;
    if (shouldSkipRel(parts)) continue;
    try {
      refs[parts.join("/")] = readFileSync(file, "utf-8");
    } catch {
      // Skip undecodable/binary files.
    }
  }
  return refs;
}

export function writeWorkspace(
  target: string,
  skill: {
    name?: string;
    description?: string;
    display_name?: string | null;
    allowed_tools?: string[] | null;
    metadata?: Record<string, unknown> | null;
    body?: string | null;
    reference_files?: Record<string, string> | null;
  },
): void {
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, SKILL_FILENAME), buildSkillMd(skill), "utf-8");
  for (const [rel, content] of Object.entries(skill.reference_files ?? {})) {
    const normalized = rel.replace(/\\/g, "/");
    if (isAbsolute(normalized) || normalized.split("/").includes("..")) {
      throw new Error(`illegal reference path: ${rel}`);
    }
    const out = join(target, ...normalized.split("/"));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, String(content), "utf-8");
  }
}

export function readWorkspace(path: string): {
  fields: SkillFields;
  referenceFiles: Record<string, string>;
} {
  const skillMd = join(path, SKILL_FILENAME);
  let text: string;
  try {
    text = readFileSync(skillMd, "utf-8");
  } catch {
    throw new Error(`Missing ${SKILL_FILENAME} in ${path}`);
  }
  const fields = parseSkillMd(text, {
    defaultName: path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop(),
  });
  return { fields, referenceFiles: collectReferenceFiles(path) };
}

export function inferSkillName(path: string): string {
  const skillMd = join(path, SKILL_FILENAME);
  try {
    const fields = parseSkillMd(readFileSync(skillMd, "utf-8"), { defaultName: null });
    return fields.name;
  } catch {
    const dirnameBase =
      path
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .pop() ?? path;
    if (dirnameBase.includes("-")) return dirnameBase.slice(0, dirnameBase.lastIndexOf("-"));
    return dirnameBase;
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
