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
    />,
    { exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
}
