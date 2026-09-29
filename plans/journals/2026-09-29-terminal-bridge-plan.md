---
title: Terminal bridge plan
date: 2026-09-29
summary: Planned sagent-bridge (WebSocket + PTY + xterm) so the model can run shell commands; red team caught 4 critical approval/token flaws in draft one.
---

# Terminal bridge plan

## What happened
- Planned the terminal bridge feature in hard mode. The plan is at `plans/260929-0948-terminal-bridge/`: 8 phases, about 61h.
- Research covered browser-to-localhost WebSocket security, Chrome's Local Network Access checks, the node-pty packaging options, and xterm.js 6.
- The red team (4 reviewers) found 39 findings, which merged into 15. Four were critical in the first draft:
  - Approval returned `approved` while the root was unbound, so `execute` bound the root and ran the command without a prompt.
  - Classifying each `terminal_write` separately could be bypassed by splitting input, by history keys, or by shell escapes from vim or less.
  - The persisted token file could be read by the model and replayed from a sandbox worker on the same origin.
  - Workspace HTML previews run on the same origin (`src/ui/file-view/sandbox.ts:1-10`), so they could take over the socket.
- The production CSP `connect-src` had no `ws:` source, which would have blocked the bridge in builds.

## Decision
- Classification and root binding now happen inside the SDK approval function. Failures return `denied`. A ledger keyed by `toolCallId` ties execution to the approval.
- The bridge tracks the pending input line and the foreground process, and model commands run in `bash --noprofile --norc`.
- The token lives in memory only and changes on every start. Pairing uses a deeplink: a one-time `/pair` code redirects to a fragment that carries the token. Unlocking the vault connects.
- Previews become opaque while paired. Workers lose `WebSocket`.
- User choices: Editing behaves like Full access, where only sensitive commands ask. A persisted Allow skips even sensitive prompts. Sessions survive vault lock. macOS and Linux only. MIT license.

## Next steps
- `/ak:cook plans/260929-0948-terminal-bridge/plan.md`
- Empirically verify `pkill -s <sid>` on Linux and the Chrome `loopback-network` permission name.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
