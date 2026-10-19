import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateWorkspace } from "../src/lib/skillsValidate.js";
import {
  buildSkillMd,
  collectReferenceFiles,
  inferSkillName,
  parseSkillMd,
  readWorkspace,
  writeWorkspace,
} from "../src/lib/skillsWorkspace.js";
import { packWorkspace } from "../src/lib/skillsZip.js";

describe("skills workspace", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "digen-skill-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips frontmatter and reference files", () => {
    const target = join(dir, "my-skill");
    writeWorkspace(target, {
      name: "my-skill",
      display_name: "My Skill",
      description: "Use when the user wants a demo",
      allowed_tools: ["list_models", "generate_image"],
      body: "# My Skill\n\n## When to use\n\n- demos\n\n## Steps\n\n1. do it",
      metadata: { version: "1.0" },
      reference_files: { "references/style.md": "style guide" },
    });

    const { fields, referenceFiles } = readWorkspace(target);
    expect(fields.name).toBe("my-skill");
    expect(fields.display_name).toBe("My Skill");
    expect(fields.allowed_tools).toEqual(["list_models", "generate_image"]);
    expect(fields.metadata).toEqual({ version: "1.0" });
    expect(referenceFiles).toEqual({ "references/style.md": "style guide" });
  });

  it("parses comma-separated allowed-tools and accepts title as display_name", () => {
    const fields = parseSkillMd(
      "---\nname: demo\ntitle: Demo\ndescription: Use when demo\nallowed-tools: a, b\n---\nBody",
    );
    expect(fields.display_name).toBe("Demo");
    expect(fields.allowed_tools).toEqual(["a", "b"]);
  });

  it("packs SKILL.md and references while skipping git/scripts/binaries", () => {
    const target = join(dir, "packed");
    writeWorkspace(target, {
      name: "packed",
      description: "Use when packing",
      body: "# Packed\n\n## Steps\n\n1. go",
      reference_files: { "references/a.md": "a" },
    });
    mkdirSync(join(target, ".git"), { recursive: true });
    writeFileSync(join(target, ".git", "config"), "x");
    mkdirSync(join(target, "scripts"), { recursive: true });
    writeFileSync(join(target, "scripts", "run.py"), "x");
    writeFileSync(join(target, "cover.png"), Buffer.from([1, 2]));

    const zip = packWorkspace(target);
    const entries = Object.keys(unzipSync(zip)).sort();
    expect(entries).toEqual(["SKILL.md", "references/a.md"]);
    expect(strFromU8(unzipSync(zip)["references/a.md"] ?? new Uint8Array())).toBe("a");
  });

  it("infers name from frontmatter first, then directory prefix", () => {
    const target = join(dir, "fallback-20260101");
    mkdirSync(target);
    expect(inferSkillName(target)).toBe("fallback");
    writeWorkspace(target, {
      name: "from-frontmatter",
      description: "Use when inferring",
      body: "# x",
    });
    expect(inferSkillName(target)).toBe("from-frontmatter");
  });

  it("collects only text reference files", () => {
    const target = join(dir, "refs");
    writeWorkspace(target, { name: "refs", description: "Use when refs", body: "# x" });
    mkdirSync(join(target, "references"), { recursive: true });
    writeFileSync(join(target, "references", "a.md"), "a");
    writeFileSync(join(target, "references", "b.bin"), Buffer.from([0, 1]));
    expect(collectReferenceFiles(target)).toEqual({ "references/a.md": "a" });
  });

  it("builds valid SKILL.md text", () => {
    const text = buildSkillMd({
      name: "built",
      description: "Use when built",
      allowed_tools: ["list_models"],
      body: "# Built",
    });
    expect(text).toContain("name: built");
    expect(text).toContain("allowed-tools:");
    expect(text).toContain("# Built");
  });

  it("reports forbidden tools, missing reference files, and missing sections", () => {
    const target = join(dir, "bad");
    writeWorkspace(target, {
      name: "bad",
      description: "short",
      allowed_tools: ["write_skill"],
      body: "# Bad\n\nRead `references/missing.md`.",
    });
    const result = validateWorkspace(target);
    expect(result.errors).toContain(
      "allowed-tools includes authoring tools reserved for official skills: write_skill (user skills cannot declare these; the server will strip them)",
    );
    expect(result.errors).toContain("body references a missing file: references/missing.md");
    expect(result.warnings.some((w) => w.includes("When to use"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("Steps"))).toBe(true);
  });

  it("reports a missing SKILL.md", () => {
    expect(validateWorkspace(join(dir, "absent")).errors).toEqual(["missing SKILL.md"]);
  });
});
