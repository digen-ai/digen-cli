---
"digen": minor
---

`digen chat` is now a mouse-driven TUI (built on Ink) when run in a real terminal. Generated assets
(images, videos, audio, documents) are shown as links only — no more inline image rendering — and
hovering an asset link pops open a preview panel with an ANSI-block thumbnail for images/videos, or
name/type/link metadata for other types; clicking opens the asset in your default browser/app.
Non-interactive environments (piped output, no pty) keep using the existing plain-text REPL, which
also no longer renders images inline.
