---
"digen-cli": patch
---

Send the `Digen-Platform` header (`cli` for the CLI, `mcp` for the MCP server) and include
`platform` in `client_env` when creating conversations, matching the vid-agent API convention.
