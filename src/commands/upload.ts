import chalk from "chalk";
import type { Command } from "commander";
import { getDefaultWorkflow } from "../lib/config.js";
import { handleCommandError, handleJsonError, isJson, printJson, success } from "../lib/output.js";
import { getClient, requireLogin } from "../lib/session.js";
import {
  formatBytes,
  stageAttachment,
  uploadAttachment,
  waitForAssetParsing,
} from "../lib/uploads.js";

function parseMetadata(raw?: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--metadata must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Invalid --metadata JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function registerUploadCommand(program: Command): void {
  program
    .command("upload")
    .description("Upload image/video/audio/document files and register them as conversation assets")
    .argument("<file...>", "Local file paths")
    .option(
      "-c, --conversation <id>",
      "Conversation to upload into (default: create a pending one)",
    )
    .option("-w, --workflow <name>", "Workflow for the auto-created conversation")
    .option("--wait", "Wait for document parsing to finish", false)
    .option("--timeout <seconds>", "Parsing wait timeout in seconds", "120")
    .option("--metadata <json>", "Extra asset metadata as a JSON object")
    .action(
      async (
        files: string[],
        opts: {
          conversation?: string;
          workflow?: string;
          wait: boolean;
          timeout: string;
          metadata?: string;
        },
      ) => {
        if (!requireLogin()) {
          process.exitCode = 1;
          return;
        }
        const json = isJson(program);
        const client = getClient();
        try {
          const staged = files.map((file) => stageAttachment(file));
          const metadata = parseMetadata(opts.metadata);
          let conversationId = opts.conversation;
          if (!conversationId) {
            const conv = await client.createConversation(opts.workflow ?? getDefaultWorkflow());
            conversationId = conv.conversation_id;
          }
          const assets: Array<Record<string, unknown>> = [];
          for (const attachment of staged) {
            if (!json) {
              console.log(
                chalk.dim(`↑ Uploading ${attachment.name} (${formatBytes(attachment.size)})…`),
              );
            }
            const block = await uploadAttachment(client, conversationId, attachment, { metadata });
            const assetId = String(block.asset_id ?? "");
            let parsingStatus: unknown = undefined;
            if (attachment.assetType === "document") {
              if (opts.wait) {
                const timeoutMs = Math.max(1, Number.parseInt(opts.timeout, 10) || 120) * 1000;
                const status = await waitForAssetParsing(client, conversationId, assetId, {
                  timeoutMs,
                  onPoll: (poll) => {
                    if (!json) {
                      console.log(
                        chalk.dim(`  parsing ${assetId}: ${poll.parsing_status ?? "pending"}`),
                      );
                    }
                  },
                });
                parsingStatus = status.parsing_status;
                if (parsingStatus === "failed") {
                  throw new Error(`Document parsing failed for ${attachment.name}`);
                }
              } else {
                const status = await client.getAssetStatus(conversationId, assetId);
                parsingStatus = status.parsing_status;
              }
            }
            const result = { ...block, parsing_status: parsingStatus };
            assets.push(result);
            if (!json) {
              const suffix = parsingStatus ? `  parsing=${String(parsingStatus)}` : "";
              success(
                `${attachment.name} -> ${block.type} ${assetId}${suffix}\n  ${String(block.uri)}`,
              );
            }
          }
          if (json) {
            printJson({ conversation_id: conversationId, assets });
          } else {
            console.log(chalk.dim(`\nConversation: ${conversationId}`));
            console.log(chalk.dim(`Send it with: digen chat -c ${conversationId}`));
          }
        } catch (err) {
          if (json) handleJsonError(err);
          else handleCommandError(err);
        }
      },
    );
}
