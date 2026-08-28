# digen

[![CI](https://github.com/digen-ai/digen-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/digen-ai/digen-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/digen.svg)](https://www.npmjs.com/package/digen)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

An interactive command-line chat client for the [Digen](https://digen.ai) agent API. Log in once,
then chat with Digen's agents straight from your terminal — streaming responses, tool calls, and
generated assets included.

## Quick start

```bash
npx digen login
npx digen chat
```

Or install it globally:

```bash
npm install -g digen
digen login
digen chat
```

`digen login` opens a browser to sign in with Google and stores your credentials in
`~/.digen/cli.yaml`. If a browser can't be opened (e.g. over SSH), pass `--manual` to paste the
token instead, or `--token <token>` if you already have one.

## Usage

```
digen login [--token <token>] [--manual]   Log in and save credentials
digen logout                               Clear saved credentials
digen whoami                               Show the current logged-in identity

digen config show                          Show current configuration
digen config set-api <url>                 Set the API base URL
digen config set-login-url <url>           Set the web login page base URL
digen config set-workflow <name>           Set the default workflow for `digen chat`

digen workflows                            List available workflows

digen chat [-w <workflow>] [-c <id>] [--no-images]
                                            Start (or resume) an interactive chat session
digen sessions                             List your conversations
digen history <conversationId>             Print a conversation's message history
digen delete <conversationId>              Delete a conversation
```

### Chatting

```bash
digen chat
```

Starts a new conversation using your configured default workflow (`skill_agent` unless changed via
`digen config set-workflow`). Type a message and press Enter; responses stream in as they're
generated, including tool calls, sub-agent activity, and generated assets.

When both stdin and stdout are a real terminal, `digen chat` runs as an Ink-based TUI. Otherwise
(piped output, non-interactive shells, SSH without a pty) it falls back to a plain line-based REPL
with the same slash commands.

Slash commands available inside the chat:

| Command | Description |
| --- | --- |
| `/new` | Start a new conversation |
| `/switch <id>` | Switch to an existing conversation |
| `/sessions` | List your conversations |
| `/history` | Print this conversation's history |
| `/workflow [name]` | Show or change the workflow used for new conversations |
| `/attach <path>` | Stage a local image to send with your next message |
| `/attachments` | List staged images |
| `/detach [n\|all]` | Remove a staged image (default: all) |
| `/cancel` | Cancel the currently running task |
| `/confirm` | Confirm a pending `await_confirmation` prompt |
| `/help` | Show this list |
| `/quit` | Exit |

Press `Ctrl-C` while a response is streaming to cancel that task; press it again (or `Ctrl-D`) at
the prompt to exit.

Generated assets (images, videos, audio, documents) are never dumped inline into the conversation —
only a link is shown, e.g. `🖼 image: cat.jpg` followed by its URL. In the TUI, that link is a real
clickable terminal hyperlink (OSC 8) in terminals that support it (iTerm2, Kitty, WezTerm, Windows
Terminal, VS Code, GNOME Terminal, and others) — click it (usually with Cmd/Ctrl held) to open the
asset in your system's default browser or app. Terminals without hyperlink support just show the
plain URL text, which you can select and open manually.

Pass `--no-images` or set `DIGEN_IMAGES=off` to skip resolving assets to a presigned HTTPS link
entirely — you'll see the raw link the server sent instead; this happens automatically when output
isn't a TTY (e.g. piped to a file).

### Attaching images

```
/attach ./cat.jpg
/attach ~/Pictures/dog.png
```

`/attach <path>` stages a local image (`.jpg`, `.jpeg`, `.png`, `.gif`, or `.webp`); stage as
many as you like, then type your message and press Enter — the staged images upload first and
are sent alongside the text as image blocks. Sending with no text is fine if you just want to
share the image(s). Use `/attachments` to see what's staged, and `/detach <n>` or `/detach` (no
argument detaches everything) to remove one before sending. If an upload fails, the message isn't
sent and the staged images are kept so you can retry.

### Resuming a conversation

```bash
digen chat --conversation conv_abc123
```

## Use with Codex (MCP)

`digen` also ships an MCP server, `digen-mcp`, so agents like [Codex CLI](https://developers.openai.com/codex)
can call Digen automatically instead of you driving the chat by hand.

```bash
npm install -g digen
digen login
codex mcp add digen -- digen-mcp
```

This is equivalent to adding the following to `~/.codex/config.toml`:

```toml
[mcp_servers.digen]
command = "digen-mcp"
tool_timeout_sec = 60
```

`digen-mcp` reuses the credentials saved by `digen login` (`~/.digen/cli.yaml`) — no token is passed
through the Codex configuration. Because Digen workflows can take anywhere from a few seconds to
several minutes (e.g. generating a video or image), chatting is split into two tools instead of one
blocking call:

| Tool | Purpose |
| --- | --- |
| `digen_send` | Send a message to a workflow; returns a `task_id` immediately |
| `digen_poll` | Check a task's status/output; call repeatedly until `done`/`error`/`cancelled` |
| `digen_confirm` | Confirm or cancel a task that is `await_confirmation` |
| `digen_cancel` | Cancel a running task |
| `digen_list_workflows` | List available workflows |
| `digen_history` | Fetch a conversation's message history |

Codex (or any other MCP client) discovers these tools automatically and calls them as needed —
no shell wrapping or manual invocation required.

## How it works

`digen` talks to the Digen chat API through the production gateway. Chat responses stream back over
Server-Sent Events; if the connection drops mid-response, `digen` automatically reconnects using the
last event sequence number it saw, so you won't lose any output.

```
digen login  →  ~/.digen/cli.yaml (token, session id, default workflow)
digen chat   →  GET  /public/v1/workflows            (pick a workflow)
             →  POST /api/v1/conversations            (create a conversation)
             →  POST /api/v1/chat                     (send a message, stream SSE response)
             →  GET  /api/v1/chat/resume/{taskId}      (reconnect after a dropped connection)
```

## Development

```bash
git clone https://github.com/digen-ai/digen-cli.git
cd digen-cli
npm install
npm run dev     # watch + rebuild + run
npm test        # unit tests (vitest + msw)
npm run lint    # biome
npm run build   # bundle to dist/
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full contributor guide.

## License

[Apache-2.0](./LICENSE)
