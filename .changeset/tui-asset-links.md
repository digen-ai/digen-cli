---
"digen": minor
---

`digen chat` now runs as an Ink-based TUI when used in a real terminal. Generated assets (images,
videos, audio, documents) are shown as links only — no more inline image rendering — and each link
is a real clickable terminal hyperlink (OSC 8) that opens the asset in your default browser/app on
terminals that support it (iTerm2, Kitty, WezTerm, Windows Terminal, VS Code, GNOME Terminal, and
others); unsupported terminals just see the plain URL. Non-interactive environments (piped output,
no pty) keep using the existing plain-text REPL, which also no longer renders images inline.
