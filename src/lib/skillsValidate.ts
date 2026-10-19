/** Local validation for user skill workspaces (SKILL.md + references). */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SKILL_FILENAME, collectReferenceFiles, parseSkillMd } from "./skillsWorkspace.js";

export const MAX_BODY_CHARS = 50_000;
export const MAX_REFERENCE_FILES = 15;

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Default user-authored tool ceiling (docs/SKILL_GUIDE.md section 8). */
export const KNOWN_TOOLS = new Set([
  "search_web",
  "generate_image",
  "generate_video",
  "generate_tts",
  "generate_music",
  "mix_clips",
  "list_models",
  "search_library",
  "get_library_item",
  "upscale_image",
  "split_image",
  "recognize_image",
  "recognize_video",
  "transcribe_audio",
  "fetch_video_info",
  "download_video",
  "create_document",
  "update_document",
  "get_document",
  "memory_whoami",
  "memory_query",
  "skill_kb_query",
  "memory_store",
  "memory_forget",
  "read_skill",
  "read_skill_file",
  "write_todos",
  "set_guidance",
  "switch_model",
]);

export const FORBIDDEN_TOOLS = new Set([
  "list_my_skills",
  "read_my_skill",
  "read_my_skill_file",
  "write_skill",
  "write_skill_reference_file",
  "bind_skill_preset_asset",
  "unbind_skill_preset_asset",
]);

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export function validateWorkspace(path: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const skillMd = join(path, SKILL_FILENAME);
  let text: string;
  try {
    text = readFileSync(skillMd, "utf-8");
  } catch {
    return { errors: [`missing ${SKILL_FILENAME}`], warnings };
  }

  let fields: ReturnType<typeof parseSkillMd>;
  try {
    fields = parseSkillMd(text);
  } catch (err) {
    return {
      errors: [
        `failed to parse ${SKILL_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
      ],
      warnings,
    };
  }

  const name = fields.name;
  const description = fields.description;
  const body = fields.body;
  const allowedTools = fields.allowed_tools;

  if (!name) {
    errors.push("frontmatter.name must not be empty");
  } else if (!NAME_RE.test(name)) {
    warnings.push(
      `name '${name}' should be kebab-case (lowercase letters/digits plus hyphens, e.g. image-generation); the server normalizes illegal characters to hyphens, which can collapse into a meaningless name`,
    );
  }

  if (!description.trim()) {
    errors.push("frontmatter.description must not be empty (trigger condition)");
  } else if (description.length < 10) {
    warnings.push(
      "description is too short; write 'Use when the user wants to…' and cover nearby scenarios",
    );
  }

  const forbidden = allowedTools.filter((tool) => FORBIDDEN_TOOLS.has(tool));
  if (forbidden.length > 0) {
    errors.push(
      `allowed-tools includes authoring tools reserved for official skills: ${forbidden.join(", ")} (user skills cannot declare these; the server will strip them)`,
    );
  }

  if (allowedTools.length === 0) {
    warnings.push(
      "allowed-tools is not declared; add an allowlist if the steps call platform tools",
    );
  } else {
    const unknown = allowedTools.filter(
      (tool) => !KNOWN_TOOLS.has(tool) && !FORBIDDEN_TOOLS.has(tool),
    );
    if (unknown.length > 0) {
      warnings.push(
        `allowed-tools includes tools not on the usual list: ${unknown.join(", ")} (they may be filtered by the server ceiling)`,
      );
    }
  }

  if (!body.trim()) {
    errors.push("SKILL.md body is empty");
  } else if (body.length > MAX_BODY_CHARS) {
    errors.push(`body is ${body.length} characters, over the server limit of ${MAX_BODY_CHARS}`);
  } else if (body.length > MAX_BODY_CHARS * 0.8) {
    warnings.push(
      `body is about ${body.length} characters, approaching the server limit of ${MAX_BODY_CHARS}; consider splitting into references/`,
    );
  }

  const lower = body.toLowerCase();
  if (!body.includes("何时使用") && !lower.includes("when to use")) {
    warnings.push("body should include a 'When to use' section");
  }
  if (
    !body.includes("步骤") &&
    !lower.includes("steps") &&
    !body.includes("制作阶段") &&
    !lower.includes("production stages")
  ) {
    warnings.push("body should include a 'Steps' or 'Production stages' section");
  }

  const refs = collectReferenceFiles(path);
  const refNames = Object.keys(refs);
  if (refNames.length > MAX_REFERENCE_FILES) {
    errors.push(
      `${refNames.length} reference files, over the server limit of ${MAX_REFERENCE_FILES}`,
    );
  }

  for (const rel of refNames) {
    if (!rel.includes("/")) {
      warnings.push(
        `reference file '${rel}' should live in a subdirectory (e.g. references/${rel}); bare filenames are harder to organize`,
      );
    }
  }

  const mentioned = [...body.matchAll(/`(references\/[^`]+)`/g)].map((match) => match[1] ?? "");
  for (const rel of mentioned) {
    if (!refNames.includes(rel)) {
      errors.push(`body references a missing file: ${rel}`);
    }
  }

  for (const tool of allowedTools) {
    if (tool === "list_models") continue;
    if (body.includes(tool)) continue;
    if (Object.values(refs).some((content) => content.includes(tool))) continue;
    warnings.push(`allowed-tools includes '${tool}', but the body/references never mention it`);
  }

  return { errors, warnings };
}
