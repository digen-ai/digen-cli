# digen-cli

## 0.3.3

### Patch Changes

- b3b127b: Keep gateway tokens that already include a suffix intact, and surface HTTP 200 `errCode` responses instead of starting a chat with no conversation.

## 0.3.0

### Minor Changes

- 27100ce: Add upload/asset/task commands, generic chat attachments, and merge the retired Python
  `digenskill` CLI into `digen skill` (authoring, publish lifecycle, marketplace, preset assets,
  knowledge base, sharing, and creator stats). Legacy `~/.digen/skill.yaml` credentials migrate to
  `~/.digen/cli.yaml` automatically.
- a8071ff: `digen chat` now supports explicit skill invocation: type `/<name>` anywhere in a message to send a
  `type: "skill"` block alongside the unchanged text (up to 3 per message, order-preserving and
  de-duplicated). Add `/skills [--refresh]` to list invokable skills. Names are matched against the
  skill's runtime `name` (not its market slug), and a leading unknown `/name` is still reported as an
  unknown command rather than sent.

### Patch Changes

- 7976caf: `digen --version` and the MCP server now report the installed package version.
- 053ccd6: Send the `Digen-Platform` header (`cli` for the CLI, `mcp` for the MCP server) and include
  `platform` in `client_env` when creating conversations, matching the vid-agent API convention.

## 0.2.0

### Minor Changes

- 44839aa: `digen chat` now supports attaching local images. Use `/attach <path>` to stage one or more
  `.jpg`/`.jpeg`/`.png`/`.gif`/`.webp` files, `/attachments` to list what's staged, and
  `/detach [n|all]` to remove one or all of them. Staged images upload (presign -> S3 -> register)
  when you next send a message and are included as image blocks alongside your text — sending with
  no text is fine if you just want to share the image(s). Works in both the Ink TUI and the
  non-interactive REPL.
- 689e3cb: `digen chat` now runs as an Ink-based TUI when used in a real terminal. Generated assets (images,
  videos, audio, documents) are shown as links only — no more inline image rendering — and each link
  is a real clickable terminal hyperlink (OSC 8) that opens the asset in your default browser/app on
  terminals that support it (iTerm2, Kitty, WezTerm, Windows Terminal, VS Code, GNOME Terminal, and
  others); unsupported terminals just see the plain URL. Non-interactive environments (piped output,
  no pty) keep using the existing plain-text REPL, which also no longer renders images inline.

### Patch Changes

- 76cbba5: Fix garbled/unclickable asset links in the TUI. When a resolved asset link (label +
  OSC 8 hyperlink) was too long to fit on one line, it was rendered as two sibling `Text`
  elements inside a `Box`, which Ink wraps as independent columns — causing the label and
  link to interleave into scrambled, non-clickable output. The label and link are now a
  single `Text` run so they wrap together as continuous text.
