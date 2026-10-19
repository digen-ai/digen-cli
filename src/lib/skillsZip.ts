/** Zip packing for skill workspaces (pure TypeScript via fflate). */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { SKILL_FILENAME, shouldSkipRel } from "./skillsWorkspace.js";

/** Server-side hard limit for POST/PUT `/skills/import-zip`. */
export const MAX_SKILL_ZIP_BYTES = 2 * 1024 * 1024;

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  visit(root);
  return out;
}

/** Pack a workspace into a zip with SKILL.md at the root. */
export function packWorkspace(path: string): Buffer {
  const root = resolve(path);
  const files: Record<string, Uint8Array> = {};
  let hasSkillMd = false;
  for (const file of walkFiles(root)) {
    const rel = relative(root, file).split(/[\\/]/).join("/");
    const parts = rel.split("/");
    if (rel !== SKILL_FILENAME && shouldSkipRel(parts)) continue;
    if (rel === SKILL_FILENAME) hasSkillMd = true;
    files[rel] = new Uint8Array(readFileSync(file));
  }
  if (!hasSkillMd) throw new Error(`Missing required file: ${SKILL_FILENAME}`);
  const zipped = zipSync(files, { level: 6 });
  const buffer = Buffer.from(zipped);
  if (buffer.byteLength > MAX_SKILL_ZIP_BYTES) {
    throw new Error(
      `skill zip is ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB, over the 2MB limit`,
    );
  }
  return buffer;
}

/** Build a minimal zip from text files; used by tests/tools that don't need disk I/O. */
export function packTextFiles(files: Record<string, string>): Buffer {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) entries[name] = strToU8(content);
  return Buffer.from(zipSync(entries, { level: 6 }));
}
