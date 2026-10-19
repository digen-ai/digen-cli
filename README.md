# digen

[![CI](https://github.com/digen-ai/digen-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/digen-ai/digen-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/digen-cli.svg)](https://www.npmjs.com/package/digen-cli)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

An interactive command-line client for the [Digen](https://digen.ai) agent API. Log in once, then
chat with Digen's agents and manage your skills from the terminal — streaming responses, tool calls,
generated assets, file uploads, and skill authoring included.

Published on npm as [`digen-cli`](https://www.npmjs.com/package/digen-cli) (`npm install -g digen-cli`).
The commands are still `digen` and `digen-mcp`.

## Quick start

```bash
npx digen-cli login
npx digen-cli chat
```

Or install it globally:

```bash
npm install -g digen-cli
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
digen config set-user <id>                 Set your Digen user id if login omitted it
digen config set-workflow <name>           Set the default workflow for `digen chat`

digen workflows                            List available workflows

digen chat [-w <workflow>] [-c <id>] [--attach <path>]... [--no-images]
                                            Start (or resume) an interactive chat session
digen sessions [--bookmarked] [--featured-status <s>]
                                            List your conversations
digen conversation <conversationId>        Show conversation details
digen history <conversationId> [--limit --offset --before]
                                            Print a conversation's message history
digen rename <conversationId> <name>       Rename a conversation
digen set-workflow <conversationId> <workflow>
                                            Change a pending conversation's workflow
digen delete <conversationId>              Delete a conversation

digen upload <file...> [-c <id>] [-w <workflow>] [--wait]
                                            Upload image/video/audio/document assets
digen asset url <assetId...> [--providers aws] [--thumbnail]
                                            Resolve presigned asset URLs
digen asset status <assetId> -c <id>       Show document parsing status

digen tasks [--type <type>]                List active tasks
digen task <taskId>                        Show task details
digen task cancel <taskId>                 Cancel a task
digen task signal <taskId> confirm|cancel  Reply to an await_confirmation prompt

digen skill <command>                      Create, validate, publish, browse, install skills
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
| `/attach <path>` | Stage a local image/video/audio/document for the next message |
| `/attachments` | List staged attachments |
| `/detach [n\|all]` | Remove a staged attachment (default: all) |
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

### Attaching files

```
/attach ./cat.jpg
/attach ~/Pictures/demo.mp4
```

`/attach <path>` stages a local file; accepted types are images (`.jpg`, `.jpeg`, `.png`, `.gif`,
`.webp`), video (`.mp4`, `.webm`), audio (`.mp3`, `.wav`, `.ogg`, `.flac`, `.m4a`), and documents
(`.pdf`, `.docx`, `.txt`, `.md`). Stage as many as you like, then type your message and press
Enter — the staged files upload first and are sent alongside the text as the matching content
blocks. Sending with no text is fine if you just want to share the files. Use `/attachments` to see
what's staged, and `/detach <n>` or `/detach` (no argument detaches everything) to remove one before
sending. Document attachments wait for parsing to complete before the message is sent. If an upload
fails, the message isn't sent and the staged files are kept so you can retry.

You can also stage files before the first message:

```bash
digen chat --attach ./cat.jpg --attach ./brief.pdf
```

### Uploading assets without chatting

```bash
digen upload ./cat.jpg
digen upload ./brief.pdf --wait
digen upload ./demo.mp4 --conversation conv_abc123
```

Without `--conversation`, `digen upload` creates a pending conversation using your default workflow
and prints its id. Each file goes through presign → S3 PUT → asset registration. `--wait` polls a
document until parsing is `completed` or `failed`. Use `digen asset url <assetId>` to get a
temporary access URL later.

### Resuming a conversation

```bash
digen chat --conversation conv_abc123
```

## Managing skills

`digen` is also the user-side skill CLI (the separate `digenskill` command has been retired). All
skill operations live under `digen skill`:

| Command | Description |
|---------|-------------|
| `digen skill list` / `info <id\|slug>` | Browse your space / inspect a skill |
| `digen skill init <name>` / `checkout <id>` | Create a local template / pull an existing skill |
| `digen skill validate [path]` | Validate `SKILL.md` and references locally |
| `digen skill push [path] [--id]` | Pack and upload (create or overwrite live content) |
| `digen skill create` / `import` / `update` / `delete` / `export` | Direct API operations |
| `digen skill publish` / `unpublish` / `cancel-review` / `content` | Publish lifecycle |
| `digen skill listing <id> --file <json>` | Update listing/category/slug/locales |
| `digen skill enable` / `disable <id>` | Personal enable/disable |
| `digen skill market` / `categories` | Browse the marketplace |
| `digen skill install` / `uninstall` / `fork` / `favorite` / `report` | Market actions |
| `digen skill share` / `unshare` / `install-shared <token>` | Private sharing links |
| `digen skill cover` / `clip <id> <file>` | Upload listing cover images / sample clips |
| `digen skill preset upload\|bind\|remove` | Manage preset assets |
| `digen skill kb add\|list\|remove\|entries\|query\|create\|update\|delete` | Manage a skill knowledge base |
| `digen skill stats [id]` | Creator overview or per-skill usage |

Skills are authored in `~/.digen/skills/<name>-<suffix>/` with automatic git initialization.
Workspaces and credentials from the old Python CLI are migrated automatically: on first run,
`~/.digen/skill.yaml` is merged into `~/.digen/cli.yaml` and kept as `skill.yaml.bak`.

Use `--json` anywhere in the command line for machine-readable output.

## Use with MCP clients

`digen` also ships an MCP server, `digen-mcp`, so agents like [Claude Code](https://code.claude.com),
[Cursor](https://cursor.com/docs/mcp), and [Codex CLI](https://developers.openai.com/codex) can call
Digen automatically instead of you driving the chat by hand.

```bash
npm install -g digen-cli
digen login
```

`digen-mcp` reuses the credentials saved by `digen login` (`~/.digen/cli.yaml`) — no token is passed
through the MCP configuration. If a GUI client can't find `digen-mcp`, it likely isn't on that app's
`PATH`; use the output of `which digen-mcp`, or run it via npx:

```json
{ "command": "npx", "args": ["-y", "-p", "digen-cli", "digen-mcp"] }
```

### Claude Code

```bash
claude mcp add --transport stdio --scope user digen -- digen-mcp
```

Or add the following to `~/.claude.json` (user scope) or `.mcp.json` at the project root (shared
with the team):

```json
{
  "mcpServers": {
    "digen": {
      "type": "stdio",
      "command": "digen-mcp"
    }
  }
}
```

### Cursor

Add the server from **Cursor Settings → MCP**, or write `~/.cursor/mcp.json` (all projects) /
`.cursor/mcp.json` (this project):

```json
{
  "mcpServers": {
    "digen": {
      "command": "digen-mcp"
    }
  }
}
```

### Codex

```bash
codex mcp add digen -- digen-mcp
```

This is equivalent to adding the following to `~/.codex/config.toml`:

```toml
[mcp_servers.digen]
command = "digen-mcp"
tool_timeout_sec = 60
```

### Claude Desktop

Edit `claude_desktop_config.json`, then fully restart Claude Desktop:

| OS | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "digen": {
      "command": "digen-mcp"
    }
  }
}
```

### VS Code (GitHub Copilot)

Create `.vscode/mcp.json` in the workspace, or run **MCP: Open User Configuration**. The root key is
`servers`, not `mcpServers`:

```json
{
  "servers": {
    "digen": {
      "type": "stdio",
      "command": "digen-mcp"
    }
  }
}
```

### Gemini CLI

```bash
gemini mcp add -s user digen digen-mcp
```

Or add to `~/.gemini/settings.json` (user) / `.gemini/settings.json` (project):

```json
{
  "mcpServers": {
    "digen": {
      "command": "digen-mcp"
    }
  }
}
```

### Windsurf

Write `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "digen": {
      "command": "digen-mcp"
    }
  }
}
```

### Tools

Because Digen workflows can take anywhere from a few seconds to several minutes (e.g. generating a
video or image), chatting is split into two tools instead of one blocking call:

| Tool | Purpose |
| --- | --- |
| `digen_send` | Send a message to a workflow; returns a `task_id` immediately |
| `digen_poll` | Check a task's status/output; call repeatedly until `done`/`error`/`cancelled` |
| `digen_confirm` | Confirm or cancel a task that is `await_confirmation` |
| `digen_cancel` | Cancel a running task |
| `digen_list_workflows` | List available workflows |
| `digen_history` | Fetch a conversation's message history |

The MCP client discovers these tools automatically and calls them as needed — no shell wrapping or
manual invocation required.

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
