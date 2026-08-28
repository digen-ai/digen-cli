---
"digen": minor
---

`digen chat` now supports attaching local images. Use `/attach <path>` to stage one or more
`.jpg`/`.jpeg`/`.png`/`.gif`/`.webp` files, `/attachments` to list what's staged, and
`/detach [n|all]` to remove one or all of them. Staged images upload (presign -> S3 -> register)
when you next send a message and are included as image blocks alongside your text — sending with
no text is fine if you just want to share the image(s). Works in both the Ink TUI and the
non-interactive REPL.
