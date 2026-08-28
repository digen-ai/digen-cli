# digen-cli

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
