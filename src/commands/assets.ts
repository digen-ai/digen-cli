import chalk from "chalk";
import type { Command } from "commander";
import { handleCommandError, handleJsonError, isJson, printJson, success } from "../lib/output.js";
import { getClient, requireLogin } from "../lib/session.js";

export function registerAssetCommands(program: Command): void {
  const asset = program.command("asset").description("Inspect uploaded/generated assets");

  asset
    .command("url")
    .description("Resolve presigned access URLs for asset ids")
    .argument("<assetId...>", "Asset ids")
    .option("--providers <list>", "Comma-separated storage providers", "aws")
    .option("--thumbnail", "Show thumbnail URLs when available", false)
    .action(async (assetIds: string[], opts: { providers: string; thumbnail: boolean }) => {
      if (!requireLogin()) {
        process.exitCode = 1;
        return;
      }
      const json = isJson(program);
      const client = getClient();
      try {
        const providers = opts.providers
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
        const data = await client.getPresignedUrls(
          assetIds.map((assetId) => ({ asset_id: assetId, providers })),
        );
        if (json) {
          printJson(data);
          return;
        }
        for (const result of data.results) {
          const url =
            providers.map((p) => result.urls[p]).find(Boolean) ?? Object.values(result.urls)[0];
          if (result.error) {
            console.log(chalk.red(`${result.asset_id}: ${result.error}`));
            continue;
          }
          success(result.asset_id);
          if (url) console.log(`  ${url}`);
          if (opts.thumbnail && result.thumbnail_urls) {
            const thumb = Object.values(result.thumbnail_urls).find(Boolean);
            if (thumb) console.log(chalk.dim(`  thumb: ${thumb}`));
          }
        }
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });

  asset
    .command("status")
    .description("Show an asset's parsing status")
    .argument("<assetId>", "Asset id")
    .requiredOption("-c, --conversation <id>", "Conversation id")
    .action(async (assetId: string, opts: { conversation: string }) => {
      if (!requireLogin()) {
        process.exitCode = 1;
        return;
      }
      const json = isJson(program);
      try {
        const data = await getClient().getAssetStatus(opts.conversation, assetId);
        if (json) {
          printJson(data);
          return;
        }
        console.log(
          `${chalk.bold(assetId)}  type=${String(data.type ?? "?")}  parsing=${String(data.parsing_status ?? "-")}`,
        );
      } catch (err) {
        if (json) handleJsonError(err);
        else handleCommandError(err);
      }
    });
}
