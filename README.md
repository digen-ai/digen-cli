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

### Resuming a conversation

```bash
digen chat --conversation conv_abc123
```

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
