import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import type { Command } from "commander";
import { SKILLS_DIR } from "../lib/config.js";
import {
  fail,
  handleCommandError,
  handleJsonError,
  isJson,
  parseList,
  printJson,
  success,
} from "../lib/output.js";
import { getClient, getSkillsApi, requireLogin } from "../lib/session.js";
import type {
  SkillCreatePayload,
  SkillListingPayload,
  SkillUpdatePayload,
} from "../lib/skillsApi.js";
import { validateWorkspace } from "../lib/skillsValidate.js";
import {
  SKILL_FILENAME,
  inferSkillName,
  isDirectory,
  writeWorkspace,
} from "../lib/skillsWorkspace.js";
import { packWorkspace } from "../lib/skillsZip.js";
import { attachmentInfoForPath } from "../lib/uploads.js";

const SKILL_ID_FILE = ".digen-skill-id";

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : [];
}

function readText(path: string): string {
  if (path === "-") return readFileSync(0, "utf-8");
  return readFileSync(path, "utf-8");
}

function readJsonObject(path: string): Json {
  const text = readText(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON in ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed as Json;
}

function parseVisibility(value?: string): "private" | "public" | undefined {
  if (value === undefined) return undefined;
  if (value !== "private" && value !== "public") {
    throw new Error("--visibility must be private or public");
  }
  return value;
}

async function confirmAction(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function timestampSuffix(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function dateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
}

function initGitWorkspace(target: string, message: string): void {
  try {
    if (!existsSync(join(target, ".git"))) git(target, ["init", "-q"]);
    git(target, ["add", "."]);
    git(target, [
      "-c",
      "user.email=digenskill@local",
      "-c",
      "user.name=digenskill",
      "commit",
      "-q",
      "-m",
      message,
    ]);
  } catch (err) {
    console.log(chalk.yellow(`Warning: git init/commit failed: ${String(err)}`));
  }
}

function commitIfDirty(path: string, message: string): void {
  if (!existsSync(join(path, ".git"))) return;
  try {
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: path, encoding: "utf-8" });
    if (!status.stdout.trim()) return;
    git(path, ["add", "."]);
    git(path, [
      "-c",
      "user.email=digenskill@local",
      "-c",
      "user.name=digenskill",
      "commit",
      "-q",
      "-m",
      message,
    ]);
  } catch (err) {
    console.log(chalk.yellow(`Warning: git commit failed: ${String(err)}`));
  }
}

function printMySkills(data: Json): void {
  const builtin = asArray(data.builtin);
  const space = asArray(data.space);
  const printRows = (title: string, rows: Json[]) => {
    console.log(chalk.bold(`${title} (${rows.length})`));
    for (const row of rows) {
      console.log(
        `  ${String(row.id ?? "?")}  ${String(row.name ?? "?")}  ${String(row.display_name ?? "")}  ${String(row.status ?? "")}  enabled=${String(row.enabled ?? true)}`,
      );
    }
  };
  if (builtin.length > 0) printRows("Built-in Skills", builtin);
  printRows("My Space", space);
  console.log(
    chalk.dim(
      `Space capacity: ${String(data.space_total ?? space.length)} / mount limit ${String(data.max_mounted ?? "?")}`,
    ),
  );
}

function printMarket(data: Json): void {
  const rows = asArray(data.skills);
  console.log(
    chalk.bold(`Market · ${String(data.tab ?? "discover")} (${String(data.total ?? rows.length)})`),
  );
  for (const row of rows) {
    const author = String(asRecord(row.author).handle ?? "");
    console.log(
      `  ${String(row.id ?? "?")}  ${String(row.name ?? "?")}  ${String(row.title ?? "")}  ${String(row.primary_category ?? "")}  ${author}  installs=${String(row.installs ?? 0)}  favorites=${String(row.favorites ?? 0)}`,
    );
  }
}

function printSkillInfo(skill: Json): void {
  console.log(
    chalk.bold(
      `#${String(skill.id)}  ${String(skill.name ?? "")}  ${String(skill.display_name ?? "")}`.trim(),
    ),
  );
  console.log(`Description: ${String(skill.description ?? "")}`);
  console.log(
    `Visibility: ${String(skill.visibility ?? "")}  Status: ${String(skill.status ?? "")}  Review: ${String(skill.review_status ?? "-")}  Enabled: ${String(skill.enabled ?? "-")}`,
  );
  const tools = Array.isArray(skill.allowed_tools) ? skill.allowed_tools.map(String) : [];
  console.log(`Allowed tools: ${tools.length > 0 ? tools.join(", ") : "(none)"}`);
  const refs = asRecord(skill.reference_files);
  if (Object.keys(refs).length > 0) {
    console.log(`Reference files (${Object.keys(refs).length}):`);
    for (const path of Object.keys(refs).sort()) console.log(`  - ${path}`);
  }
  const body = String(skill.body ?? "");
  if (body) console.log(`\n${body.length > 800 ? `${body.slice(0, 800)}\n…` : body}`);
}

function mergeListing(skill: Json, mutate: (listing: Json) => void): SkillListingPayload {
  const listing = asRecord(skill.listing);
  const copy = JSON.parse(JSON.stringify(listing)) as Json;
  if (copy.schema_version === undefined) copy.schema_version = 1;
  mutate(copy);
  return { listing: copy };
}

function uploadBytes(
  client: ReturnType<typeof getClient>,
  presigned: Json,
  bytes: Buffer,
  contentType: string,
): Promise<void> {
  const uploadUrl = String(presigned.upload_url ?? "");
  const maxSize = Number(presigned.max_size ?? 0);
  if (!uploadUrl) throw new Error("Presign response did not include upload_url");
  if (maxSize > 0 && bytes.byteLength > maxSize) {
    throw new Error(`File is ${bytes.byteLength} bytes, over the ${maxSize} byte limit`);
  }
  return client.uploadToPresignedUrl(uploadUrl, bytes, contentType, { acl: null });
}

function fileInfo(path: string): { bytes: Buffer; contentType: string; filename: string } {
  const info = attachmentInfoForPath(path);
  if (!info) throw new Error(`Unsupported file type: ${path}`);
  return {
    bytes: readFileSync(path),
    contentType: info.contentType,
    filename:
      path
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .pop() ?? path,
  };
}

export function registerSkillCommand(program: Command): void {
  const skill = program
    .command("skill")
    .description("Create, publish, browse, and install Digen skills");

  skill
    .command("list")
    .description("List built-in and user skills")
    .action(async () => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const data = await getSkillsApi().list();
        if (json) printJson(data);
        else printMySkills(data);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  skill
    .command("info")
    .description("Show skill details")
    .argument("<idOrSlug>", "Skill id or slug")
    .option("--no-draft", "Show only published content (overlay_draft=false)")
    .action(async (idOrSlug: string, opts: { draft?: boolean }) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const api = getSkillsApi();
        const data = /^\d+$/.test(idOrSlug)
          ? await api.get(idOrSlug, { overlayDraft: opts.draft !== false })
          : await api.getBySlug(idOrSlug, { overlayDraft: opts.draft !== false });
        if (json) printJson(data);
        else printSkillInfo(data);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  skill
    .command("create")
    .description("Create a skill directly through the API")
    .requiredOption("--display-name <name>", "Display name")
    .option("--description <text>", "Trigger description")
    .option("--body <text>", "Markdown body")
    .option("--body-file <path>", "Read the Markdown body from a file (or - for stdin)")
    .option("--tools <list>", "Comma-separated allowed tools")
    .option("--visibility <visibility>", "private | public")
    .option("--locales <list>", "Comma-separated product locales")
    .action(
      async (opts: {
        displayName: string;
        description?: string;
        body?: string;
        bodyFile?: string;
        tools?: string;
        visibility?: string;
        locales?: string;
      }) => {
        if (!requireLogin()) return;
        const json = isJson(program);
        try {
          const payload: SkillCreatePayload = { display_name: opts.displayName };
          if (opts.description !== undefined) payload.description = opts.description;
          if (opts.bodyFile) payload.body = readText(opts.bodyFile);
          else if (opts.body !== undefined) payload.body = opts.body;
          const tools = parseList(opts.tools);
          if (tools) payload.allowed_tools = tools;
          const visibility = parseVisibility(opts.visibility);
          if (visibility) payload.visibility = visibility;
          const locales = parseList(opts.locales);
          if (locales) payload.locales = locales;
          const data = await getSkillsApi().create(payload);
          if (json) printJson(data);
          else
            success(
              `Created skill #${String(data.id)} (${String(data.name ?? payload.display_name)})`,
            );
        } catch (err) {
          if (json) handleJsonError(err);
          else handleCommandError(err);
        }
      },
    );

  skill
    .command("import")
    .description("Import a SKILL.md text file")
    .argument("<path>", "SKILL.md path (or - for stdin)")
    .option("--visibility <visibility>", "private | public")
    .option("--locales <list>", "Comma-separated product locales")
    .action(async (path: string, opts: { visibility?: string; locales?: string }) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const visibility = parseVisibility(opts.visibility);
        const data = await getSkillsApi().importText(readText(path), {
          visibility,
          locales: parseList(opts.locales),
        });
        if (json) printJson(data);
        else success(`Imported skill #${String(data.id)} (${String(data.name)})`);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  skill
    .command("update")
    .description("Update your skill's live content")
    .argument("<id>", "Skill id")
    .option("--file <json>", "Full update payload as JSON (or - for stdin)")
    .option("--display-name <name>")
    .option("--description <text>")
    .option("--body <text>")
    .option("--body-file <path>")
    .option("--tools <list>", "Comma-separated allowed tools")
    .option("--visibility <visibility>", "private | public")
    .action(
      async (
        id: string,
        opts: {
          file?: string;
          displayName?: string;
          description?: string;
          body?: string;
          bodyFile?: string;
          tools?: string;
          visibility?: string;
        },
      ) => {
        if (!requireLogin()) return;
        const json = isJson(program);
        try {
          const payload: SkillUpdatePayload = opts.file ? readJsonObject(opts.file) : {};
          if (opts.displayName !== undefined) payload.display_name = opts.displayName;
          if (opts.description !== undefined) payload.description = opts.description;
          if (opts.bodyFile) payload.body = readText(opts.bodyFile);
          else if (opts.body !== undefined) payload.body = opts.body;
          const tools = parseList(opts.tools);
          if (tools) payload.allowed_tools = tools;
          const visibility = parseVisibility(opts.visibility);
          if (visibility) payload.visibility = visibility;
          const data = await getSkillsApi().update(id, payload);
          if (json) printJson(data);
          else success(`Updated skill #${id}`);
        } catch (err) {
          if (json) handleJsonError(err);
          else handleCommandError(err);
        }
      },
    );

  skill
    .command("delete")
    .description("Delete your skill")
    .argument("<id>", "Skill id")
    .option("--yes", "Skip the confirmation prompt", false)
    .action(async (id: string, opts: { yes: boolean }) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        if (!opts.yes && !(await confirmAction(`Delete skill #${id}? This cannot be undone`))) {
          return;
        }
        await getSkillsApi().delete(id);
        if (json) printJson({ ok: true, skill_id: id });
        else success(`Deleted #${id}`);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  skill
    .command("export")
    .description("Download a skill zip")
    .argument("<id>", "Skill id")
    .option("-o, --output <path>", "Output zip path")
    .action(async (id: string, opts: { output?: string }) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const bytes = await getSkillsApi().exportZip(id);
        const out = opts.output ?? `skill-${id}.zip`;
        writeFileSync(out, bytes);
        if (json) printJson({ ok: true, path: out, bytes: bytes.byteLength });
        else success(`Saved ${bytes.byteLength} bytes to ${out}`);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  // ==================== Local authoring ====================

  skill
    .command("init")
    .description("Create a local skill template workspace (does not upload)")
    .argument("<name>", "Skill name (kebab-case)")
    .option("--as <suffix>", "Workspace directory suffix (default: timestamp)")
    .option("--display-name <name>")
    .option("-d, --description <text>", "Trigger description")
    .option("--force", "Overwrite an existing workspace", false)
    .action(
      async (
        name: string,
        opts: {
          as?: string;
          displayName?: string;
          description?: string;
          force: boolean;
        },
      ) => {
        const suffix = opts.as ?? timestampSuffix();
        const target = join(SKILLS_DIR, `${name}-${suffix}`);
        try {
          if (existsSync(target)) {
            if (!opts.force) {
              fail(`Target already exists: ${target}`);
              return;
            }
            const result = spawnSync("rm", ["-rf", target]);
            if (result.status !== 0) throw new Error(`Failed to remove ${target}`);
          }
          const displayName = opts.displayName ?? name;
          const description =
            opts.description ?? `Use when the user wants to use the ${name} capability`;
          writeWorkspace(target, {
            name,
            display_name: displayName,
            description,
            allowed_tools: ["list_models"],
            body: `# ${displayName}\n\nA short description of what this skill does.\n\n## When to use\n\n- Trigger scenarios that match the description\n\n## Steps\n\n1. …\n2. Call tools; parameter conventions: …\n3. Reply to the user briefly in natural language\n\n## Notes\n\n- Report failures honestly; never invent URLs\n- Politely refuse disallowed content\n`,
            metadata: {},
          });
          initGitWorkspace(target, `init: ${name}`);
          success(`Initialized workspace at ${target}`);
          console.log(chalk.dim(`cd ${target}`));
          console.log(
            chalk.dim("Edit SKILL.md, then: digen skill validate . && digen skill push ."),
          );
        } catch (err) {
          handleCommandError(err);
        }
      },
    );

  skill
    .command("checkout")
    .description("Pull an existing skill into a local workspace")
    .argument("<id>", "Skill id")
    .option("--as <suffix>", "Workspace directory suffix (default: timestamp)")
    .option("--force", "Overwrite an existing workspace", false)
    .action(async (id: string, opts: { as?: string; force: boolean }) => {
      if (!requireLogin()) return;
      try {
        const data = await getSkillsApi().get(id);
        const name = String(data.name ?? `skill-${id}`);
        const target = join(SKILLS_DIR, `${name}-${opts.as ?? timestampSuffix()}`);
        if (existsSync(target)) {
          if (!opts.force) {
            fail(
              `Target already exists: ${target}\nUse --force to overwrite, or --as <name> for a different suffix`,
            );
            return;
          }
          rmSync(target, { recursive: true, force: true });
        }
        writeWorkspace(target, data);
        writeFileSync(join(target, SKILL_ID_FILE), String(id));
        initGitWorkspace(target, `baseline: ${name}`);
        success(`Checked out #${id} ${name} -> ${target}`);
        console.log(chalk.dim(`cd ${target}`));
        console.log(chalk.dim(`# After editing: digen skill push ${target}`));
      } catch (err) {
        handleCommandError(err);
      }
    });

  skill
    .command("validate")
    .description("Validate SKILL.md and references locally")
    .argument("[path]", "Workspace directory", ".")
    .action((path: string) => {
      const target = resolve(path);
      if (!isDirectory(target)) {
        fail(`Not a directory: ${target}`);
        return;
      }
      const result = validateWorkspace(target);
      for (const warning of result.warnings) console.log(chalk.yellow(`Warning: ${warning}`));
      for (const error of result.errors) console.error(chalk.red(`Error: ${error}`));
      if (result.errors.length > 0) {
        console.error(
          chalk.red(`FAIL  ${result.errors.length} error(s), ${result.warnings.length} warning(s)`),
        );
        process.exitCode = 1;
        return;
      }
      success(`OK (${result.warnings.length} warning(s))`);
    });

  skill
    .command("push")
    .description("Validate, zip, and upload a skill (create or overwrite live content)")
    .argument("[path]", "Workspace directory", ".")
    .option("--id <id>", "Existing skill id to overwrite")
    .option(
      "--visibility <visibility>",
      "private | public (create; update applies visibility after upload)",
    )
    .option("--locales <list>", "Comma-separated product locales (create only)")
    .option("--skip-validate", "Skip local validation", false)
    .option("-m, --message <text>", "Local git commit message")
    .action(
      async (
        path: string,
        opts: {
          id?: string;
          visibility?: string;
          locales?: string;
          skipValidate: boolean;
          message?: string;
        },
      ) => {
        if (!requireLogin()) return;
        const target = resolve(path);
        const json = isJson(program);
        if (!isDirectory(target)) {
          fail(`Not a directory: ${target}`);
          return;
        }
        if (!existsSync(join(target, SKILL_FILENAME))) {
          fail(`Missing ${SKILL_FILENAME}`);
          return;
        }
        try {
          if (!opts.skipValidate) {
            const result = validateWorkspace(target);
            for (const warning of result.warnings) console.log(chalk.yellow(`Warning: ${warning}`));
            if (result.errors.length > 0) {
              for (const error of result.errors) console.error(chalk.red(`Error: ${error}`));
              throw new Error("Validation failed; fix and retry, or pass --skip-validate to force");
            }
          }
          const idFile = join(target, SKILL_ID_FILE);
          let skillId: string | undefined = opts.id;
          if (!skillId && existsSync(idFile)) skillId = readFileSync(idFile, "utf-8").trim();
          const name = inferSkillName(target);
          const zip = packWorkspace(target);
          const visibility = parseVisibility(opts.visibility);
          const api = getSkillsApi();
          let result: Json;
          if (skillId) {
            result = await api.updateZip(skillId, zip);
            if (visibility) await api.setVisibility(skillId, visibility);
            success(`Uploaded #${skillId} (${name}) — live content overwritten`);
          } else {
            result = await api.importZip(zip, {
              visibility,
              locales: parseList(opts.locales),
            });
            const newId = String(result.id ?? "");
            writeFileSync(idFile, newId);
            skillId = newId;
            success(`Created skill #${newId} (${name})`);
          }
          commitIfDirty(target, opts.message ?? `push: ${name} #${skillId}`);
          if (json) printJson({ ok: true, skill_id: skillId, name, result });
          else
            console.log(
              chalk.dim(
                "Publish from the CLI: digen skill publish <id> (or use the web UI for rich listing fields).",
              ),
            );
        } catch (err) {
          if (json) handleJsonError(err);
          else handleCommandError(err);
        }
      },
    );

  // ==================== Publish / lifecycle ====================

  skill
    .command("publish")
    .description("Optionally update listing, then request public visibility")
    .argument("<id>", "Skill id")
    .option("--file <json>", "Listing JSON to apply before publishing (or - for stdin)")
    .action(async (id: string, opts: { file?: string }) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const api = getSkillsApi();
        if (opts.file) await api.updateListing(id, readJsonObject(opts.file));
        const data = await api.setVisibility(id, "public");
        if (json) printJson(data);
        else success(`Publish requested for #${id}`);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  skill
    .command("unpublish")
    .description("Make a skill private")
    .argument("<id>", "Skill id")
    .action(async (id: string) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const data = await getSkillsApi().setVisibility(id, "private");
        if (json) printJson(data);
        else success(`#${id} is now private`);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  skill
    .command("cancel-review")
    .description("Withdraw an in-review request")
    .argument("<id>", "Skill id")
    .action(async (id: string) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const data = await getSkillsApi().cancelReview(id);
        if (json) printJson(data);
        else success(`Review request withdrawn for #${id}`);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  skill
    .command("content")
    .description("Set content visibility")
    .argument("<id>", "Skill id")
    .argument("<visibility>", "open | closed")
    .action(async (id: string, visibility: string) => {
      if (visibility !== "open" && visibility !== "closed") {
        fail("visibility must be open or closed");
        return;
      }
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const data = await getSkillsApi().setContentVisibility(id, visibility);
        if (json) printJson(data);
        else success(`#${id} content visibility=${visibility}`);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  for (const [command, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    skill
      .command(`${command} <id>`)
      .description(`${enabled ? "Enable" : "Disable"} a skill for your account`)
      .action(async (id: string) => {
        if (!requireLogin()) return;
        const json = isJson(program);
        try {
          const data = await getSkillsApi().toggle(id, enabled);
          if (json) printJson(data);
          else success(`#${id} enabled=${String(enabled)}`);
        } catch (err) {
          if (json) handleJsonError(err);
          else handleCommandError(err);
        }
      });
  }

  skill
    .command("listing")
    .description("Update market listing / category / slug / locales")
    .argument("<id>", "Skill id")
    .requiredOption("--file <json>", "Listing JSON (or - for stdin)")
    .action(async (id: string, opts: { file: string }) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const data = await getSkillsApi().updateListing(id, readJsonObject(opts.file));
        if (json) printJson(data);
        else success(`Listing updated for #${id}`);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  skill
    .command("share")
    .description("Create or get a private sharing link")
    .argument("<id>", "Skill id")
    .option("--regenerate", "Rotate and invalidate the old token", false)
    .action(async (id: string, opts: { regenerate: boolean }) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const data = await getSkillsApi().createShare(id, opts.regenerate);
        if (json) printJson(data);
        else {
          success(`Share token: ${String(data.share_token ?? "")}`);
          console.log(
            chalk.dim(
              `Share URL: https://agent.digen.ai/skills/shared/${String(data.share_token ?? "")}`,
            ),
          );
        }
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  skill
    .command("unshare")
    .description("Revoke a skill sharing link")
    .argument("<id>", "Skill id")
    .action(async (id: string) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const data = await getSkillsApi().revokeShare(id);
        if (json) printJson(data);
        else success(`Share link revoked for #${id}`);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  skill
    .command("upgrade-info")
    .description("Show installed vs current skill content diff")
    .argument("<id>", "Skill id")
    .action(async (id: string) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const data = await getSkillsApi().upgradeInfo(id);
        if (json) printJson(data);
        else console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  skill
    .command("upgrade")
    .description("Record an installed-skill upgrade (legacy API)")
    .argument("<id>", "Skill id")
    .action(async (id: string) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const data = await getSkillsApi().upgrade(id);
        if (json) printJson(data);
        else success(`Upgrade recorded for #${id}`);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  // ==================== Market ====================

  skill
    .command("market")
    .description("Browse the skill marketplace")
    .option("--tab <tab>", "discover | favorites | mine", "discover")
    .option("--category <category>")
    .option("--q <query>", "Search query")
    .option("--sort <sort>", "featured | popular | recent", "featured")
    .option("--limit <n>", "Page size", "50")
    .option("--offset <n>", "Offset", "0")
    .option("--locale <locale>")
    .action(
      async (opts: {
        tab: string;
        category?: string;
        q?: string;
        sort: string;
        limit: string;
        offset: string;
        locale?: string;
      }) => {
        if (!requireLogin()) return;
        const json = isJson(program);
        try {
          const data = await getSkillsApi().listMarket({
            tab: opts.tab,
            category: opts.category,
            q: opts.q,
            sort: opts.sort,
            limit: Number.parseInt(opts.limit, 10),
            offset: Number.parseInt(opts.offset, 10),
            locale: opts.locale,
          });
          if (json) printJson(data);
          else printMarket(data);
        } catch (err) {
          if (json) handleJsonError(err);
          else handleCommandError(err);
        }
      },
    );

  skill
    .command("categories")
    .description("List marketplace category enums")
    .action(async () => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const data = await getSkillsApi().listCategories();
        if (json) printJson(data);
        else {
          for (const category of asArray(data.categories ?? data).map(String)) {
            console.log(`  - ${category}`);
          }
        }
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  skill
    .command("install <id>")
    .description("Install a public skill")
    .action(async (id: string) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const data = await getSkillsApi().install(id);
        if (json) printJson(data);
        else success(`Installed #${id}`);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  skill
    .command("uninstall <id>")
    .description("Uninstall an installed skill")
    .action(async (id: string) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        await getSkillsApi().uninstall(id);
        if (json) printJson({ ok: true, skill_id: id });
        else success(`Uninstalled #${id}`);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  skill
    .command("fork <id>")
    .description("Fork a public skill into your own private copy")
    .action(async (id: string) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const data = await getSkillsApi().fork(id);
        if (json) printJson(data);
        else success(`Forked #${id} -> #${String(data.id)} (${String(data.name)})`);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  skill
    .command("favorite <id>")
    .description("Favorite a skill")
    .option("--remove", "Remove from favorites", false)
    .action(async (id: string, opts: { remove: boolean }) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const api = getSkillsApi();
        if (opts.remove) {
          await api.unfavorite(id);
          if (json) printJson({ ok: true, skill_id: id, favorited: false });
          else success(`Unfavorited #${id}`);
        } else {
          const data = await api.favorite(id);
          if (json) printJson(data);
          else success(`Favorited #${id}`);
        }
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  skill
    .command("report <id>")
    .description("Report a public skill")
    .option("--reason <text>", "Report reason")
    .action(async (id: string, opts: { reason?: string }) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const data = await getSkillsApi().report(id, opts.reason);
        if (json) printJson(data);
        else success(`Report submitted: ${String(data.report_id ?? "")}`);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  skill
    .command("install-shared <token>")
    .description("Install a skill through a sharing token")
    .action(async (token: string) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const data = await getSkillsApi().installShared(token);
        if (json) printJson(data);
        else success(`Installed shared skill #${String(data.skill_id ?? "")}`);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  // ==================== Cover / clip ====================

  skill
    .command("cover <id> <file>")
    .description("Upload a skill cover and merge it into the listing")
    .option("--kind <kind>", "card | hero | icon", "card")
    .option("--no-listing", "Only upload; do not update the skill listing")
    .action(async (id: string, file: string, opts: { kind: string; listing: boolean }) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        if (!["card", "hero", "icon"].includes(opts.kind)) {
          throw new Error("--kind must be card, hero, or icon");
        }
        const info = fileInfo(file);
        const type = attachmentInfoForPath(file);
        if (type?.assetType !== "image") throw new Error("Skill covers must be image files");
        const api = getSkillsApi();
        const presigned = await api.presignCover({
          filename: info.filename,
          contentType: info.contentType,
          fileSize: statSync(file).size,
        });
        await uploadBytes(getClient(), presigned, info.bytes, info.contentType);
        const url = String(presigned.final_url ?? "");
        if (opts.listing) {
          const skillData = await api.get(id);
          const payload = mergeListing(skillData, (listing) => {
            const covers = asRecord(listing.covers);
            covers[opts.kind] = url;
            listing.covers = covers;
          });
          await api.updateListing(id, payload);
        }
        if (json) printJson({ ok: true, skill_id: id, kind: opts.kind, url });
        else success(`Cover uploaded: ${url}`);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  skill
    .command("clip <id> <file>")
    .description("Upload a sample clip and append it to example_clips")
    .option("--label <text>")
    .option("--cover <url>", "Cover image URL")
    .option("--duration <seconds>", "Clip duration in seconds")
    .option("--no-listing", "Only upload; do not update the skill listing")
    .action(
      async (
        id: string,
        file: string,
        opts: {
          label?: string;
          cover?: string;
          duration?: string;
          listing: boolean;
        },
      ) => {
        if (!requireLogin()) return;
        const json = isJson(program);
        try {
          const info = fileInfo(file);
          const api = getSkillsApi();
          const presigned = await api.presignClip({
            filename: info.filename,
            contentType: info.contentType,
            fileSize: statSync(file).size,
          });
          await uploadBytes(getClient(), presigned, info.bytes, info.contentType);
          const url = String(presigned.final_url ?? "");
          if (opts.listing) {
            const skillData = await api.get(id);
            const payload = mergeListing(skillData, (listing) => {
              const clips = Array.isArray(listing.example_clips)
                ? ([...listing.example_clips] as Json[])
                : [];
              if (clips.length >= 6) throw new Error("example_clips already has 6 entries");
              const entry: Json = { url, label: opts.label ?? info.filename };
              if (opts.cover) entry.cover = opts.cover;
              if (opts.duration) entry.duration_s = Number.parseFloat(opts.duration);
              clips.push(entry);
              listing.example_clips = clips;
            });
            await api.updateListing(id, payload);
          }
          if (json) printJson({ ok: true, skill_id: id, url });
          else success(`Clip uploaded: ${url}`);
        } catch (err) {
          if (json) handleJsonError(err);
          else handleCommandError(err);
        }
      },
    );

  // ==================== Preset assets ====================

  const preset = skill.command("preset").description("Manage skill preset assets");

  preset
    .command("upload <id> <file>")
    .description("Upload and bind a preset asset")
    .requiredOption("--key <key>", "Unique key inside the skill")
    .option("--label <label>")
    .option("--live", "Write to live content instead of draft", false)
    .action(
      async (id: string, file: string, opts: { key: string; label?: string; live: boolean }) => {
        if (!requireLogin()) return;
        const json = isJson(program);
        try {
          const info = fileInfo(file);
          const data = await getSkillsApi().uploadPresetAsset(
            id,
            { bytes: info.bytes, filename: info.filename, contentType: info.contentType },
            opts.key,
            { label: opts.label, writeToDraft: !opts.live },
          );
          if (json) printJson(data);
          else success(`Preset asset '${opts.key}' uploaded for #${id}`);
        } catch (err) {
          if (json) handleJsonError(err);
          else handleCommandError(err);
        }
      },
    );

  preset
    .command("bind <id>")
    .description("Bind an existing asset as a preset asset")
    .requiredOption("--asset-id <assetId>", "Asset id")
    .requiredOption("--key <key>", "Unique key inside the skill")
    .option("--label <label>")
    .option("--live", "Write to live content instead of draft", false)
    .action(
      async (
        id: string,
        opts: {
          assetId: string;
          key: string;
          label?: string;
          live: boolean;
        },
      ) => {
        if (!requireLogin()) return;
        const json = isJson(program);
        try {
          const data = await getSkillsApi().bindPresetAsset(id, {
            asset_id: opts.assetId,
            key: opts.key,
            label: opts.label,
            write_to_draft: !opts.live,
          });
          if (json) printJson(data);
          else success(`Preset asset '${opts.key}' bound to #${id}`);
        } catch (err) {
          if (json) handleJsonError(err);
          else handleCommandError(err);
        }
      },
    );

  preset
    .command("remove <id> <assetId>")
    .description("Remove a preset asset binding")
    .option("--live", "Write to live content instead of draft", false)
    .action(async (id: string, assetId: string, opts: { live: boolean }) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const data = await getSkillsApi().unbindPresetAsset(id, assetId, !opts.live);
        if (json) printJson(data);
        else success(`Preset asset ${assetId} removed from #${id}`);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  // ==================== Knowledge base ====================

  const kb = skill.command("kb").description("Manage a skill knowledge base");

  kb.command("add <id> <file>")
    .description("Upload a KB document")
    .option("--doc-id <docId>")
    .option("--title <title>")
    .option("--live", "Write to live content instead of draft", false)
    .action(
      async (id: string, file: string, opts: { docId?: string; title?: string; live: boolean }) => {
        if (!requireLogin()) return;
        const json = isJson(program);
        try {
          const info = fileInfo(file);
          const data = await getSkillsApi().uploadKbDocument(
            id,
            { bytes: info.bytes, filename: info.filename, contentType: info.contentType },
            { docId: opts.docId, title: opts.title, writeToDraft: !opts.live },
          );
          if (json) printJson(data);
          else success(`KB document uploaded for #${id}`);
        } catch (err) {
          if (json) handleJsonError(err);
          else handleCommandError(err);
        }
      },
    );

  kb.command("list <id>")
    .description("List KB documents")
    .option("--live", "Read live content instead of draft", false)
    .action(async (id: string, opts: { live: boolean }) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const data = await getSkillsApi().listKbDocuments(id, !opts.live);
        if (json) printJson(data);
        else {
          for (const doc of asArray(data.kb_documents)) {
            console.log(
              `  ${String(doc.doc_id)}  ${String(doc.title ?? "")}  chunks=${String(doc.chunk_count ?? 0)}  ${String(doc.filename ?? "")}`,
            );
          }
        }
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  kb.command("remove <id> <docId>")
    .description("Delete a KB document")
    .option("--live", "Write to live content instead of draft", false)
    .action(async (id: string, docId: string, opts: { live: boolean }) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const data = await getSkillsApi().deleteKbDocument(id, docId, !opts.live);
        if (json) printJson(data);
        else success(`KB document ${docId} removed from #${id}`);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  kb.command("entries <id>")
    .description("List KB chunks")
    .option("--limit <n>")
    .option("--offset <n>")
    .action(async (id: string, opts: { limit?: string; offset?: string }) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const data = await getSkillsApi().listKbEntries(id, {
          limit: opts.limit ? Number.parseInt(opts.limit, 10) : undefined,
          offset: opts.offset ? Number.parseInt(opts.offset, 10) : undefined,
        });
        if (json) printJson(data);
        else {
          for (const item of asArray(data.items)) {
            console.log(
              `  ${String(item.id)}  ${String(item.kind ?? "")}  ${String(item.content ?? "").slice(0, 120)}`,
            );
          }
        }
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  kb.command("query <id> <query>")
    .description("Semantic search over a skill knowledge base")
    .option("--kind <kind>", "fact | preference | project | person | episode")
    .option("--limit <n>")
    .action(async (id: string, query: string, opts: { kind?: string; limit?: string }) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const data = await getSkillsApi().queryKb(id, query, {
          kind: opts.kind,
          limit: opts.limit ? Number.parseInt(opts.limit, 10) : undefined,
        });
        if (json) printJson(data);
        else {
          console.log(chalk.dim(`mode=${String(data.mode ?? "")}`));
          for (const item of asArray(data.items)) {
            console.log(
              `  score=${String(item.score ?? "")}  ${String(item.content ?? "").slice(0, 160)}`,
            );
          }
        }
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  kb.command("create <id>")
    .description("Create a manual KB chunk")
    .requiredOption("--content <text>")
    .option("--kind <kind>", "fact | preference | project | person | episode")
    .option("--tags <list>", "Comma-separated tags")
    .action(async (id: string, opts: { content: string; kind?: string; tags?: string }) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        const data = await getSkillsApi().createKbEntry(id, {
          content: opts.content,
          kind: opts.kind,
          tags: parseList(opts.tags),
        });
        if (json) printJson(data);
        else success(`Created KB chunk ${String(data.id ?? "")} in #${id}`);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  kb.command("update <id> <memoryId>")
    .description("Update a manual KB chunk")
    .option("--content <text>")
    .option("--kind <kind>")
    .option("--tags <list>")
    .action(
      async (
        id: string,
        memoryId: string,
        opts: {
          content?: string;
          kind?: string;
          tags?: string;
        },
      ) => {
        if (!requireLogin()) return;
        const json = isJson(program);
        try {
          const data = await getSkillsApi().updateKbEntry(id, memoryId, {
            content: opts.content,
            kind: opts.kind,
            tags: parseList(opts.tags),
          });
          if (json) printJson(data);
          else success(`Updated KB chunk ${memoryId} in #${id}`);
        } catch (err) {
          if (json) handleJsonError(err);
          else handleCommandError(err);
        }
      },
    );

  kb.command("delete <id> <memoryId>")
    .description("Delete a KB chunk")
    .action(async (id: string, memoryId: string) => {
      if (!requireLogin()) return;
      const json = isJson(program);
      try {
        await getSkillsApi().deleteKbEntry(id, memoryId);
        if (json) printJson({ ok: true, skill_id: id, memory_id: memoryId });
        else success(`Deleted KB chunk ${memoryId} from #${id}`);
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  // ==================== Creator stats ====================

  skill
    .command("stats [id]")
    .description("Creator overview, or stats for one skill")
    .option("--period <period>", "today | 7d | 30d")
    .option("--from <date>", "YYYY-MM-DD")
    .option("--to <date>", "YYYY-MM-DD")
    .action(
      async (
        id: string | undefined,
        opts: {
          period?: string;
          from?: string;
          to?: string;
        },
      ) => {
        if (!requireLogin()) return;
        const json = isJson(program);
        try {
          const period = opts.period ?? (id ? "7d" : undefined);
          const days = period === "today" ? 0 : period === "30d" ? 29 : 6;
          const from = opts.from ?? dateOffset(days);
          const to = opts.to ?? dateOffset(0);
          const api = getSkillsApi();
          const data = id
            ? await api.getCreatorSkillStats(id, { period, from: opts.from, to: opts.to })
            : await api.getCreatorOverview(from, to);
          if (json) printJson(data);
          else console.log(JSON.stringify(data, null, 2));
        } catch (err) {
          if (json) handleJsonError(err);
          else handleCommandError(err);
        }
      },
    );
}
