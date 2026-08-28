import { MouseProvider } from "@ink-tools/ink-mouse";
import chalk from "chalk";
import { Box, Static, Text, useApp, useInput } from "ink";
import open from "open";
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { DigenClient } from "../../lib/client.js";
import { ApiError } from "../../lib/errors.js";
import { printApiError, printHelp, printHistory } from "../commandHelpers.js";
import { type AssetLineData, TranscriptStore } from "../transcript.js";
import { PreviewPane } from "./PreviewPane.js";
import { TranscriptLineView } from "./TranscriptLineView.js";
import { runTurn } from "./runTurn.js";

export interface ChatTuiProps {
  client: DigenClient;
  conversationId: string;
  workflow: string;
  images?: "auto" | "off";
}

export function ChatTui({
  client,
  conversationId: initialConversationId,
  workflow: initialWorkflow,
  images,
}: ChatTuiProps) {
  const { exit } = useApp();
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [workflow, setWorkflow] = useState(initialWorkflow);
  const [inputValue, setInputValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const storeRef = useRef<TranscriptStore | null>(null);
  if (!storeRef.current) storeRef.current = new TranscriptStore({ client, images });
  const store = storeRef.current;
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
  const hoveredLine = hoveredId ? liveLines.find((l) => l.id === hoveredId) : undefined;

  const handleHoverAsset = useCallback((line: { id: string } | null) => {
    setHoveredId(line?.id ?? null);
  }, []);

  const handleOpenAsset = useCallback((data: AssetLineData) => {
    if (data.url?.startsWith("http")) void open(data.url).catch(() => {});
  }, []);

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
        default:
          console.log(chalk.yellow(`Unknown command: /${cmd} (try /help)`));
          return undefined;
      }
    },
    [client],
  );

  const submit = useCallback(
    async (text: string) => {
      if (text.startsWith("/")) {
        const result = await runSlashCommand(text);
        if (result === "quit") exit();
        return;
      }

      store.startTurn(text);
      setBusy(true);
      const controller = new AbortController();
      activeControllerRef.current = controller;
      try {
        await runTurn(
          client,
          conversationIdRef.current,
          workflowRef.current,
          text,
          store,
          controller.signal,
          (id) => {
            activeTaskIdRef.current = id;
          },
        );
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
    [client, runSlashCommand, store, exit],
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
      if (text) void submit(text);
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
    <MouseProvider>
      <Box flexDirection="column">
        <Text dimColor>
          Conversation {conversationId} · workflow {workflow}
        </Text>
        <Text dimColor>
          Hover a 🖼/🎬/🎵/📄 link to preview it, click to open. Type a message and press Enter.
          /help for commands, Ctrl-C to cancel/quit.
        </Text>
        <Static items={frozenLines}>
          {(line) => <TranscriptLineView key={line.id} line={line} interactive={false} />}
        </Static>
        <Box flexDirection="column">
          {liveLines.map((line) => (
            <TranscriptLineView
              key={line.id}
              line={line}
              interactive
              onHoverAsset={handleHoverAsset}
              onOpenAsset={handleOpenAsset}
            />
          ))}
        </Box>
        {hoveredLine?.kind === "asset" && <PreviewPane data={hoveredLine.data} />}
        <Box>
          <Text color="cyan">{"> "}</Text>
          <Text>{inputValue}</Text>
          <Text inverse> </Text>
          {busy && <Text dimColor> working…</Text>}
        </Box>
      </Box>
    </MouseProvider>
  );
}
