/**
 * `digen-mcp` — a stdio MCP server exposing the Digen chat API as tools
 * that an MCP-capable agent (e.g. Codex CLI) can call automatically.
 *
 * Digen workflows can take anywhere from a few seconds to several minutes
 * (video/image generation, multi-step agent tasks), but a single MCP tool
 * call must return promptly. So chat is split into two tools instead of
 * one blocking call:
 *
 *   digen_send  — starts a turn, returns a task_id immediately
 *   digen_poll  — returns the current aggregated result for that task_id
 *
 * Authentication is read from `~/.digen/cli.yaml` (run `digen login` once);
 * no token is ever passed through the MCP/Codex configuration.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { pickUrl } from "../lib/assets.js";
import type { DigenClient } from "../lib/client.js";
import { getDefaultWorkflow, loadConfig } from "../lib/config.js";
import { ApiError } from "../lib/errors.js";
import { getClient } from "../lib/session.js";
import type { AggregatedAsset } from "./aggregate.js";
import { TaskRegistry } from "./tasks.js";

function textResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(err: unknown): CallToolResult {
  const message =
    err instanceof ApiError ? err.detail : err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

/** Resolves each asset to a fetchable URL, presigning where necessary; falls back to the raw uri on failure. */
async function resolveAssetLinks(
  client: DigenClient,
  assets: AggregatedAsset[],
): Promise<{ type: string; name: string; url: string }[]> {
  const toPresign = assets.filter(
    (a): a is AggregatedAsset & { assetId: string } =>
      !a.url && Boolean(a.assetId) && a.providers.length > 0,
  );
  const resolved = new Map<AggregatedAsset, string>();
  if (toPresign.length > 0) {
    try {
      const presigned = await client.getPresignedUrls(
        toPresign.map((a) => ({ asset_id: a.assetId, providers: a.providers })),
      );
      toPresign.forEach((asset, i) => {
        const result = presigned.results[i];
        if (result && !result.error) {
          const url = pickUrl(result.urls, asset.providers);
          if (url) resolved.set(asset, url);
        }
      });
    } catch {
      // Presigning failed (e.g. network blip); fall back to raw links below.
    }
  }
  return assets.map((a) => ({
    type: a.type,
    name: a.name,
    url: a.url ?? resolved.get(a) ?? a.uri ?? "",
  }));
}

export function registerTools(
  server: McpServer,
  client: DigenClient,
  registry: TaskRegistry,
): void {
  server.registerTool(
    "digen_send",
    {
      title: "Send a message to Digen",
      description:
        "Send a message to a Digen agent workflow to generate creative content (video, image, audio, " +
        "document) or handle a multi-step agent task. Returns immediately with a task_id — Digen " +
        "workflows can take from seconds to several minutes, so call digen_poll with that task_id to " +
        "check progress and fetch the result. To continue an existing conversation (e.g. answer a " +
        "follow-up question or clarification), pass its conversation_id.",
      inputSchema: {
        message: z.string().describe("The message/prompt to send to Digen"),
        workflow: z
          .string()
          .optional()
          .describe(
            `Workflow name to use (default: "${getDefaultWorkflow()}"). Call digen_list_workflows to see available workflows and what they do.`,
          ),
        conversation_id: z
          .string()
          .optional()
          .describe(
            "Existing conversation id to continue (from a previous digen_send/digen_poll result). Omit to start a new conversation.",
          ),
      },
    },
    async ({ message, workflow, conversation_id }) => {
      try {
        const { taskId, conversationId } = await registry.send({
          message,
          workflow: workflow ?? getDefaultWorkflow(),
          conversationId: conversation_id,
        });
        return textResult({ task_id: taskId, conversation_id: conversationId, status: "running" });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "digen_poll",
    {
      title: "Poll a Digen task",
      description:
        "Check the status and current output of a task started with digen_send. Call this " +
        "repeatedly (e.g. every few seconds, with backoff) until status is 'done', 'error', or " +
        "'cancelled'. If status is 'await_confirmation', call digen_confirm to proceed or cancel " +
        "before polling again.",
      inputSchema: {
        task_id: z.string().describe("The task_id returned by digen_send"),
      },
    },
    async ({ task_id }) => {
      try {
        const turn = await registry.poll(task_id);
        const assets = await resolveAssetLinks(client, turn.assets);
        return textResult({
          status: turn.status,
          text: turn.text,
          assets,
          error: turn.errorMessage,
          confirmation_type: turn.confirmationType,
          suggested_questions: turn.suggestedQuestions,
          consumer_error: turn.consumerError,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "digen_confirm",
    {
      title: "Confirm or cancel a pending Digen action",
      description:
        "Respond to a task that is in the 'await_confirmation' state (as reported by digen_poll). " +
        "Use action 'confirm' to proceed with the pending action, or 'cancel' to abort it.",
      inputSchema: {
        task_id: z.string().describe("The task_id awaiting confirmation"),
        action: z.enum(["confirm", "cancel"]).describe("Whether to proceed or abort"),
      },
    },
    async ({ task_id, action }) => {
      try {
        await client.confirmCountdown(task_id, action);
        return textResult({ ok: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "digen_cancel",
    {
      title: "Cancel a running Digen task",
      description: "Cancel a task that is currently running.",
      inputSchema: {
        task_id: z.string().describe("The task_id to cancel"),
      },
    },
    async ({ task_id }) => {
      try {
        await client.cancelTask(task_id);
        return textResult({ ok: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "digen_list_workflows",
    {
      title: "List available Digen workflows",
      description:
        "List the Digen agent workflows available to this account, with their names and descriptions. " +
        "Use this to pick a workflow name to pass to digen_send.",
      inputSchema: {},
    },
    async () => {
      try {
        const workflows = await client.listWorkflows();
        return textResult({ workflows });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "digen_history",
    {
      title: "Get a Digen conversation's message history",
      description: "Fetch the full message history for an existing Digen conversation.",
      inputSchema: {
        conversation_id: z.string().describe("The conversation id to fetch history for"),
      },
    },
    async ({ conversation_id }) => {
      try {
        const data = await client.getConversationMessages(conversation_id);
        return textResult(data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}

function ensureLoggedIn(): void {
  const cfg = loadConfig();
  if (!cfg.token && cfg.user_id === undefined) {
    process.stderr.write("digen-mcp: not logged in. Run `digen login` first, then retry.\n");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  ensureLoggedIn();
  const client = getClient();
  const registry = new TaskRegistry(client);

  const server = new McpServer({ name: "digen", version: "0.1.0" });
  registerTools(server, client, registry);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** True when this file is the process entrypoint (including via an npm bin symlink). */
export function isDirectRun(argv1 = process.argv[1], moduleUrl = import.meta.url): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

// Only launch the stdio server when this module is run directly (e.g.
// `digen-mcp` / `node dist/mcp.js`), not when imported for testing.
if (isDirectRun()) {
  main().catch((err) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`digen-mcp: fatal error: ${message}\n`);
    process.exit(1);
  });
}
