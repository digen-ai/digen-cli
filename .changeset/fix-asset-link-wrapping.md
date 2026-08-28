---
"digen": patch
---

Fix garbled/unclickable asset links in the TUI. When a resolved asset link (label +
OSC 8 hyperlink) was too long to fit on one line, it was rendered as two sibling `Text`
elements inside a `Box`, which Ink wraps as independent columns — causing the label and
link to interleave into scrambled, non-clickable output. The label and link are now a
single `Text` run so they wrap together as continuous text.
