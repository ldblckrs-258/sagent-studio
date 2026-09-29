---
title: Terminal bridge implemented
date: 2026-09-29
summary: All eight phases of the sagent-bridge terminal plan built; review bypasses fixed; build and browser smoke pending.
---

# Terminal bridge implemented

## What happened
- Built the `sagent-bridge` package:
  - loopback WebSocket with a Host → Origin → token guard
  - one-time `/pair` deeplink
  - exec and PTY sessions with a 1 MiB ring buffer
  - bash classifier (web-tree-sitter) and line tracker
- Built the app side: bridge client and manager, root binding, approval gate with ledger and lane, six terminal tools, Terminal panel with xterm.js, and docs.
- The plan's unverified assumption failed: macOS `pgrep`/`pkill` have no `-s`, and `ps` reports session id 0. The kill now snapshots the process table with `ps` (descendants, process groups, PTY tty, and session id on Linux) before signalling. Model shells use `-l -O huponexit`.
- The code review found two `terminal_write` bypasses:
  - Ctrl-P, Ctrl-A, Ctrl-U or `!!` replayed an earlier command.
  - Two writes in one step combined into a command neither check saw.

## Decision
- Model interactive shells run with history off (`+H +o history`, `HISTSIZE=0`).
- Once a line is opaque, it stays opaque until it is submitted.
- The bridge requires an input version on every model write, and returns `stale_input` when it changed or is missing. The tool reports this as `conflict`.
- The classifier was hardened with about 50 new bypass cases. The new rules:
  - globs in command names
  - `env -S`, `trap`, `alias`
  - pipes into an interpreter behind a wrapper
  - abbreviated long options
  - package-manager exec
  - git `rebase -x`, `submodule foreach` and `config`
  - `setsid` and `tmux`
- `ensureBound` runs before the persisted-Allow shortcut, so a disconnected bridge is never approved.

## Results
- `pnpm test`: 2030 passed.
- `pnpm bridge:test`: 340 passed, on macOS and on Linux in Docker.
- Lint and `tsc` are clean.
- The packed tarball installs with `--ignore-scripts` and reports `exec,pty,classify`.

## Next steps
- Run `pnpm build` after the user OKs it, and check that xterm loads as a lazy chunk.
- Do the browser smoke test: deeplink, unlock, then panel `ready`.
- Product decision on preview isolation (H2): a same-origin preview opened before pairing can keep code in the parent page.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
