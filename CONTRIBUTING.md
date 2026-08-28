# Contributing to digen

Thanks for your interest in improving `digen`! This is a small project, so the process is
intentionally lightweight.

## Development setup

Requires Node.js >= 20.

```bash
git clone https://github.com/digen-ai/digen-cli.git
cd digen-cli
npm install
```

Useful scripts:

| Command | What it does |
| --- | --- |
| `npm run dev` | Rebuild on change and run the CLI (`dist/index.js`) |
| `npm run build` | Bundle `src/` into `dist/` with tsup |
| `npm test` | Run the unit test suite (vitest) |
| `npm run typecheck` | Type-check with `tsc --noEmit` |
| `npm run lint` | Lint and format-check with Biome |
| `npm run lint:fix` | Auto-fix lint/format issues |

To try your local build as the `digen` command:

```bash
npm run build
node dist/index.js --help
# or: npm link
```

## Project layout

```
src/
  index.ts        CLI entry point (commander setup)
  commands/       One file per top-level command (login, chat, config, ...)
  lib/            Config, auth, the HTTP/SSE client, and shared types
  ui/             Terminal rendering and the interactive chat REPL
tests/            vitest unit tests (msw for HTTP mocking)
```

`lib/client.ts` is the only place that knows about the Digen gateway API; `ui/` only knows about
rendering events and reading input. Keeping that boundary clean makes both sides easier to test
and easier to reuse (e.g. from a future non-interactive command).

## Making a change

1. Fork the repo and create a branch.
2. Make your change, with tests where it makes sense (`tests/*.test.ts`, using `msw` to mock HTTP
   calls — see `tests/client.test.ts` for an example).
3. Run `npm run lint && npm run typecheck && npm test` and fix anything that fails.
4. If your change is user-facing (new command, changed behavior, bug fix), add a changeset:

   ```bash
   npm run changeset
   ```

   Pick the appropriate bump (patch/minor/major) and describe the change from a user's
   perspective. This file gets committed alongside your change.
5. Open a pull request. CI will run lint, typecheck, tests, and a build on Node 20 and 22.

## Reporting bugs / requesting features

Please open a [GitHub issue](https://github.com/digen-ai/digen-cli/issues) with as much detail as
you can — the command you ran, what you expected, and what happened instead.

## Code style

Formatting and basic lint rules are enforced by [Biome](https://biomejs.dev/) (`npm run lint`).
There's no separate style guide beyond "match the surrounding code."
