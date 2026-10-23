import { render } from "ink";
import type { DigenClient } from "../../lib/client.js";
import type { StagedAttachment } from "../../lib/uploads.js";
import { ChatTui } from "./App.js";

export interface ChatTuiOptions {
  client: DigenClient;
  conversationId: string;
  workflow: string;
  images?: "auto" | "off";
  attachments?: StagedAttachment[];
  /** Sent as the first turn once the TUI is up; the prompt stays open afterward. */
  message?: string;
}

/** Mount the interactive, mouse-driven chat TUI and resolve once the user quits. */
export async function runChatTui(opts: ChatTuiOptions): Promise<void> {
  const instance = render(
    <ChatTui
      client={opts.client}
      conversationId={opts.conversationId}
      workflow={opts.workflow}
      images={opts.images}
      attachments={opts.attachments}
      message={opts.message}
    />,
    { exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
}
