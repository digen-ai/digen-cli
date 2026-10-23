---
"digen-cli": minor
---

`digen chat` now supports explicit skill invocation: type `/<name>` anywhere in a message to send a
`type: "skill"` block alongside the unchanged text (up to 3 per message, order-preserving and
de-duplicated). Add `/skills [--refresh]` to list invokable skills. Names are matched against the
skill's runtime `name` (not its market slug), and a leading unknown `/name` is still reported as an
unknown command rather than sent.
