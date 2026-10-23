import chalk from "chalk";
import { Box, Static, Text, useApp, useInput } from "ink";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { DigenClient } from "../../lib/client.js";
import { ApiError } from "../../lib/errors.js";
import {
  type ResolvedSkillInvocation,
  SkillInvoker,
  leadingSkillToken,
} from "../../lib/skillsInvoke.js";
import {
  type StagedAttachment,
  buildMessageBlocks,
  formatBytes,
  stageAttachment,
  waitForDocumentBlocks,
} from "../../lib/uploads.js";
import {
  parseChatSlashCommand,
  printApiError,
  printHelp,
  printHistory,
  printSkillList,
} from "../commandHelpers.js";
import { TranscriptStore } from "../transcript.js";
import { TranscriptLineView } from "./TranscriptLineView.js";
import { runTurn } from "./runTurn.js";

export interface ChatTuiProps {
  client: DigenClient;
  conversationId: string;
  workflow: string;
  images?: "auto" | "off";
  attachments?: StagedAttachment[];
}

export function ChatTui({
  client,
  conversationId: initialConversationId,
  workflow: initialWorkflow,
  images,
  attachments: initialAttachments,
}: ChatTuiProps) {
  const { exit } = useApp();
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [workflow, setWorkflow] = useState(initialWorkflow);
  const [inputValue, setInputValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [stagedAttachments, setStagedAttachments] = useState<StagedAttachment[]>(
    initialAttachments ?? [],
  );
  const stagedAttachmentsRef = useRef(stagedAttachments);
  stagedAttachmentsRef.current = stagedAttachments;

  const storeRef = useRef<TranscriptStore | null>(null);
  if (!storeRef.current) storeRef.current = new TranscriptStore({ client, images });
  const store = storeRef.current;
  const invokerRef = useRef<SkillInvoker | null>(null);
  if (!invokerRef.current) invokerRef.current = new SkillInvoker(client);
  const skillInvoker = invokerRef.current;
  const subscribe = useMemo(() => store.subscribe.bind(store), [store]);
  const lines = useSyncExternalStore(subscribe, store.getLines);

  const activeControllerRef = useRef<AbortController | null>(null);
  const activeTaskIdRef = useRef<string | null>(null);
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  const workflowRef = useRef(workflow);
  workflowRef.current = workflow;

  const currentTurn = store.getCurrentTurn();
  const frozenLines = useMemo(
    () => lines.filter((l) => l.turn < currentTurn),
    [lines, currentTurn],
  );
  const liveLines = useMemo(
    () => lines.filter((l) => l.turn === currentTurn),
    [lines, currentTurn],
  );

  const runSlashCommand = useCallback(
    async (line: string): Promise<"quit" | undefined> => {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(" ").trim();
      switch (cmd) {
        case "quit":
        case "exit":
          return "quit";
        case "help":
          printHelp();
          return undefined;
        case "new": {
          const conv = await client.createConversation(workflowRef.current);
          setConversationId(conv.conversation_id);
          console.log(chalk.green(`✔ New conversation ${conv.conversation_id}`));
          return undefined;
        }
        case "switch": {
          if (!arg) {
            console.log(chalk.yellow("Usage: /switch <conversationId>"));
            return undefined;
          }
          try {
            const conv = await client.getConversation(arg);
            setConversationId(arg);
            const nextWorkflow = (conv.workflow as string | undefined) ?? workflowRef.current;
            setWorkflow(nextWorkflow);
            console.log(chalk.green(`✔ Switched to ${arg} (${nextWorkflow})`));
          } catch (err) {
            console.log(chalk.red(err instanceof ApiError ? err.detail : String(err)));
          }
          return undefined;
        }
        case "sessions": {
          const conversations = await client.listConversations();
          for (const conv of conversations) {
            console.log(
              `${conv.conversation_id}  ${chalk.cyan(conv.workflow)}  ${conv.name ?? ""}`,
            );
          }
          return undefined;
        }
        case "history":
          await printHistory(client, conversationIdRef.current);
          return undefined;
        case "workflow":
          if (arg) {
            setWorkflow(arg);
            console.log(chalk.green(`✔ Workflow for new messages set to ${arg}`));
          } else {
            console.log(`Current workflow: ${chalk.cyan(workflowRef.current)}`);
          }
          return undefined;
        case "skills":
          try {
            printSkillList(
              await skillInvoker.list({ refresh: arg === "refresh" || arg === "--refresh" }),
            );
          } catch (err) {
            console.log(chalk.red(err instanceof ApiError ? err.detail : String(err)));
          }
          return undefined;
        case "cancel":
          if (activeTaskIdRef.current) {
            await client.cancelTask(activeTaskIdRef.current).catch(() => {});
            console.log(chalk.yellow("✔ Cancel requested"));
          } else {
            console.log(chalk.dim("No task is running"));
          }
          return undefined;
        case "confirm":
          if (activeTaskIdRef.current) {
            await client.confirmCountdown(activeTaskIdRef.current, "confirm").catch(() => {});
          } else {
            console.log(chalk.dim("No task is awaiting confirmation"));
          }
          return undefined;
        case "attach": {
          if (!arg) {
            console.log(chalk.yellow("Usage: /attach <path>"));
            return undefined;
          }
          try {
            const attachment = stageAttachment(arg);
            const nextCount = stagedAttachmentsRef.current.length + 1;
            setStagedAttachments((prev) => [...prev, attachment]);
            console.log(
              chalk.green(
                `✔ Attached ${attachment.name} (${formatBytes(attachment.size)}) — ${nextCount} attachment${nextCount === 1 ? "" : "s"} staged`,
              ),
            );
          } catch (err) {
            console.log(chalk.red(err instanceof Error ? err.message : String(err)));
          }
          return undefined;
        }
        case "attachments": {
          const list = stagedAttachmentsRef.current;
          if (list.length === 0) {
            console.log(chalk.dim("No attachments staged"));
          } else {
            list.forEach((attachment, i) => {
              console.log(
                `  ${i + 1}. ${attachment.name} (${formatBytes(attachment.size)}, ${attachment.assetType})`,
              );
            });
          }
          return undefined;
        }
        case "detach": {
          const list = stagedAttachmentsRef.current;
          if (!arg || arg === "all") {
            setStagedAttachments([]);
            console.log(
              chalk.green(`✔ Detached ${list.length} attachment${list.length === 1 ? "" : "s"}`),
            );
          } else {
            const index = Number.parseInt(arg, 10);
            if (!Number.isInteger(index) || index < 1 || index > list.length) {
              console.log(chalk.yellow(`Usage: /detach [n|all] (1-${list.length || 0})`));
            } else {
              const removed = list[index - 1];
              setStagedAttachments(list.filter((_, i) => i !== index - 1));
              console.log(chalk.green(`✔ Detached ${removed?.name}`));
            }
          }
          return undefined;
        }
        default:
          return undefined;
      }
    },
    [client, skillInvoker],
  );

  const submit = useCallback(
    async (text: string) => {
      if (parseChatSlashCommand(text)) {
        const result = await runSlashCommand(text);
        if (result === "quit") exit();
        return;
      }

      setBusy(true);
      let invocation: ResolvedSkillInvocation;
      try {
        invocation = await skillInvoker.resolve(text);
      } catch (err) {
        if (err instanceof ApiError) printApiError(err);
        else console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        setBusy(false);
        return;
      }
      if (text.startsWith("/") && invocation.invoked.length === 0) {
        const leading = leadingSkillToken(text);
        if (leading && invocation.disabled.includes(leading)) {
          console.log(
            chalk.yellow(
              `Skill /${leading} is disabled. Re-enable it with \`digen skill enable <id>\`.`,
            ),
          );
        } else {
          const [cmd] = text.slice(1).split(/\s+/);
          console.log(chalk.yellow(`Unknown command or skill: /${cmd} (try /help or /skills)`));
        }
        setBusy(false);
        return;
      }

      const attachmentsToSend = stagedAttachmentsRef.current;
      const attachmentSuffix =
        attachmentsToSend.length > 0 ? `📎 ${attachmentsToSend.map((i) => i.name).join(", ")}` : "";
      store.startTurn([text, attachmentSuffix].filter(Boolean).join(" "));
      const controller = new AbortController();
      activeControllerRef.current = controller;
      try {
        const blocks = await buildMessageBlocks(
          client,
          conversationIdRef.current,
          attachmentsToSend,
          text,
          (attachment, index, total) => {
            console.log(chalk.dim(`↑ Uploading ${attachment.name} (${index + 1}/${total})…`));
          },
          invocation.blocks,
        );
        await waitForDocumentBlocks(client, conversationIdRef.current, blocks);
        await runTurn(
          client,
          conversationIdRef.current,
          workflowRef.current,
          blocks,
          store,
          controller.signal,
          (id) => {
            activeTaskIdRef.current = id;
          },
        );
        setStagedAttachments([]);
      } catch (err) {
        if (!(err instanceof Error && err.name === "AbortError")) {
          if (err instanceof ApiError) printApiError(err);
          else console.error(chalk.red(String(err)));
        }
      } finally {
        activeControllerRef.current = null;
        activeTaskIdRef.current = null;
        setBusy(false);
      }
    },
    [client, runSlashCommand, store, exit, skillInvoker],
  );

  useInput((input, key) => {
    if (input === "c" && key.ctrl) {
      const controller = activeControllerRef.current;
      if (controller) {
        console.log(chalk.yellow("Cancelling…"));
        controller.abort();
        const taskId = activeTaskIdRef.current;
        activeControllerRef.current = null;
        activeTaskIdRef.current = null;
        if (taskId) void client.cancelTask(taskId).catch(() => {});
      } else {
        console.log(chalk.dim("Bye!"));
        exit();
      }
      return;
    }
    if (input === "d" && key.ctrl) {
      if (!busy) exit();
      return;
    }
    if (busy) return;
    if (key.return) {
      const text = inputValue.trim();
      setInputValue("");
      if (text || stagedAttachmentsRef.current.length > 0) void submit(text);
      return;
    }
    if (key.backspace || key.delete) {
      setInputValue((v) => v.slice(0, -1));
      return;
    }
    if (
      key.escape ||
      key.tab ||
      key.upArrow ||
      key.downArrow ||
      key.leftArrow ||
      key.rightArrow ||
      key.pageUp ||
      key.pageDown
    ) {
      return;
    }
    if (input) setInputValue((v) => v + input);
  });

  return (
    <Box flexDirection="column">
      <Text dimColor>
        Conversation {conversationId} · workflow {workflow}
      </Text>
      <Text dimColor>
        🖼/🎬/🎵/📄 links are clickable in terminals that support it. Type a message and press Enter.
        /help for commands, Ctrl-C to cancel/quit.
      </Text>
      <Static items={frozenLines}>
        {(line) => <TranscriptLineView key={line.id} line={line} />}
      </Static>
      <Box flexDirection="column">
        {liveLines.map((line) => (
          <TranscriptLineView key={line.id} line={line} />
        ))}
      </Box>
      {stagedAttachments.length > 0 && (
        <Text dimColor>
          📎 {stagedAttachments.length} staged: {stagedAttachments.map((i) => i.name).join(", ")}
        </Text>
      )}
      <Box>
        <Text color="cyan">{"> "}</Text>
        <Text>{inputValue}</Text>
        <Text inverse> </Text>
        {busy && <Text dimColor> working…</Text>}
      </Box>
    </Box>
  );
}
