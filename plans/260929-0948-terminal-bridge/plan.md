---
title: "Terminal bridge — model and user run shell commands on the local machine"
description: "A companion npm package (sagent-bridge) runs PTY and exec sessions over an authenticated 127.0.0.1 WebSocket, pairs through a deeplink, and gives the browser harness terminal tools, a sensitive-command approval gate, and an xterm.js panel."
status: in-progress
priority: P1
effort: 61h
branch: main
tags: [feature, frontend, backend, api, auth, critical]
blockedBy: []
blocks: []
created: 2026-09-29
source: ../reports/researcher-260929-1643-pty-bridge-security.md
---

# Terminal bridge

## Overview

sagent-studio is a static SPA and cannot spawn processes. A new package, `sagent-bridge`, runs on the user's machine (`npx sagent-bridge --root <workspace>`). It prints a link and opens a browser tab. The user unlocks the vault and the app connects to the bridge's authenticated WebSocket on `127.0.0.1`.

Commands run in three shapes: one-shot exec with an exit code, long-running sessions, and interactive PTY sessions. The model gets six terminal tools, sensitive commands ask for approval, and every session appears in an xterm.js Terminal panel.

## Decisions (user, 2026-09-29)

- **Approach C:** WebSocket, PTY and xterm.js over a first-party protocol.
- **Session types:** one-shot, long-running and interactive sessions all ship in v1.
- **Approval:** a set of sensitive commands asks. Editing works the same as Full access, and Read-only asks for every command. A persisted **Allow** runs even sensitive commands without asking.
- **Sub-agents:** they can use the tools, scoped to their parent thread's sessions.
- **Distribution:** a publishable npm package, `sagent-bridge`, under the MIT license. The name was free on npm on 2026-09-29.
- **Deeplink pairing:** the bridge prints a link and opens a tab, and unlocking the vault connects. The link carries a one-time code. The `/pair` redirect places the token in the URL fragment.
- **Token:** held in memory and new on every bridge start. The user re-opens the link after a restart.
- **Preview isolation:** while a bridge is paired, workspace HTML previews lose `allow-same-origin`.
- **Vault lock:** sessions keep running, and the app reattaches after unlock.
- **Platforms:** macOS and Linux. Windows exits with an "unsupported" message.

## Key design choices

- **Transport:** `ws` on `127.0.0.1`. Host and Origin allowlists are checked separately. The token travels as a subprotocol and is compared in constant time.
- **PTY:** `@lydell/node-pty`, pinned, behind an adapter, with an exec-only fallback.
- **Model commands** run in `/bin/bash --noprofile --norc`. The tree-sitter-bash classifier then matches the shell, and profile aliases cannot hide what runs.
- **Classification happens in the bridge.**
  - Command lines are parsed and fail closed.
  - Typed input is judged by the whole pending line and the foreground program.
  - This keeps `'wasm-unsafe-eval'` out of the app CSP.
- **Approval is decided inside the SDK approval function.**
  - Binding and classification both happen there, and any failure is `denied`.
  - A ledger keyed by `toolCallId` ties execution to what was approved.
  - It builds on `resolveApprovalStatus` instead of replacing it.
- **Root binding:**
  - It uses a one-time probe file per nonce and is single-flight per thread.
  - It is cached per connection epoch and per handle object (`isSameEntry`).
  - Sub-agents bind to their parent thread's folder.
- **Same-origin code is locked out:**
  - Sandbox workers lose `WebSocket`, `EventSource` and `WebTransport`.
  - Workspace previews become opaque while a bridge is paired.
  - The token never enters tool results, and it is redacted from command output.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Workspace and shared protocol](./phase-01-workspace-and-protocol.md) | Completed |
| 2 | [Bridge server, authentication, and deeplink pairing](./phase-02-bridge-server-and-auth.md) | Completed |
| 3 | [Bridge sessions and command classifier](./phase-03-bridge-sessions-and-classifier.md) | Completed |
| 4 | [App bridge client, deeplink pairing, and root binding](./phase-04-app-bridge-client-and-pairing.md) | Completed |
| 5 | [Approval gate for commands](./phase-05-approval-gate-for-commands.md) | Completed |
| 6 | [Model terminal tools](./phase-06-model-terminal-tools.md) | Completed |
| 7 | [Terminal panel UI](./phase-07-terminal-panel-ui.md) | Completed |
| 8 | [Docs and end-to-end verification](./phase-08-docs-and-end-to-end.md) | Completed |

Dependencies:
- Phase 3 needs phase 2, which needs phase 1.
- Phase 4 needs phases 1 and 2.
- Phase 5 needs phases 3 and 4. Phase 6 needs phase 5, and phase 7 needs phase 6.
- Phase 8 needs all of them.

## Success Criteria

- [ ] `npx sagent-bridge --root <dir>` starts on macOS and Linux without build tools, opens a tab, and after unlock the panel shows `ready`.
- [x] The bridge rejects a socket with no token, a foreign Origin or a rebinding Host before any session exists. A sandbox worker cannot open a WebSocket.
- [x] The model runs `git status` and gets the exit code and output. It starts `pnpm dev`, reads the output, and kills it.
- [x] An interactive session answers a y/n prompt through `terminal_write`, and the user can type into the same session in the panel.
- [x] In Editing and Full access, these ask for approval with a reason: `rm -rf build`, `curl … | sh`, `sudo …`, a split `rm -r`+`f`, `up`+`enter`, and an unparseable command. `ls` and `git status` do not ask. With a persisted Allow, nothing asks.
- [x] A disconnected or unbound bridge is `denied`, never `approved`.
- [x] A sensitive command from a sub-agent queues an Allow/Deny card. Stopping the sub-agent kills its sessions.
- [x] A cwd outside the root is refused. Killing a session also kills its background jobs. Stopping the bridge leaves no processes behind.
- [x] The token never appears in thread storage, tool results or model requests.
- [ ] `pnpm test`, `pnpm lint`, `pnpm bridge:test` and `pnpm build` pass.

## Dependencies

- **App:** `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0, `@xterm/addon-web-links` 0.12.0. Dev only: `ws` 8.22.0.
- **Bridge, pinned exactly:**
  - `ws` 8.22.0, `@lydell/node-pty` 1.2.0-beta.15, `strip-ansi` 7.2.0.
  - `web-tree-sitter`: the 0.25.x release that matches the grammar, chosen and pinned in phase 3.
  - Dev only: `tree-sitter-bash` 0.25.1, whose wasm is copied into `dist/`.
  - Ships with `npm-shrinkwrap.json`.
- **Research:** [security](../reports/researcher-260929-1643-pty-bridge-security.md), [package and xterm](../reports/researcher-260929-1643-pty-package-and-xterm.md).

## Red Team Review

### Session — 2026-09-29
**Findings:** 15 after deduplication of 39 raw findings (15 accepted, 0 rejected). 4 sub-points were rejected.
**Severity breakdown:** 4 Critical, 8 High, 3 Medium.

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | Approval failed open while unbound or reconnecting; commands raced out of order | Critical | Accept | Phase 5 |
| 2 | `terminal_write` bypasses: split input, history keys, shell escapes in other programs | Critical | Accept | Phase 3, 5 |
| 3 | Token readable by the model and replayable from a same-origin worker; leak test could not fail | Critical | Accept | Phase 2, 4, 6, 8 |
| 4 | Same-origin workspace HTML preview could hijack the socket | Critical | Accept (user chose "opaque while paired") | Phase 4 |
| 5 | Model could read, write or kill the user's own sessions | High | Accept | Phase 5, 6 |
| 6 | Classifier gaps: zsh vs bash grammar, profile env, outside-root reads, upload flags, broad root | High | Accept | Phase 2, 3 |
| 7 | Stop, thread deletion, abort and rewind left sessions running without an owner | High | Accept | Phase 3, 6 |
| 8 | Root-binding cache key, probe race, permission, sub-agent folder | High | Accept | Phase 3, 4 |
| 9 | Command tools were missing from `EDITING_TOOLS`, so sub-agents never got them | High | Accept | Phase 5 |
| 10 | CSP `connect-src` had no `ws:` source | High | Accept | Phase 1 |
| 11 | PTY kill missed background jobs; exec stdin; UTF-8 and escape-sequence cuts; login-shell noise | High | Accept | Phase 3 |
| 12 | Test infrastructure: Node WebSocket sends no Origin, in-memory handle, tsconfig | High | Accept | Phase 1, 4 |
| 13 | New Dexie table duplicated the Settings secrets and missed the wipe lists | Medium | Accept | Phase 4 |
| 14 | Parallel approval function; duplicated reason UI; missing callers (engine deps, `builtinProviders`, `BUILTIN_NAMES`) | Medium | Accept | Phase 4, 5, 6 |
| 15 | Over-specification (rate limit, client cap, pidfile, 8 statuses, `tty`/`name`, Open in terminal, extra flags, Windows) and supply chain | Medium | Accept | Phase 2, 3, 4, 6, 7, 8 |

Rejected sub-points:
- "Treat workspace scripts and build runners as sensitive" and "switch Editing to an allowlist" would reverse the user decision to prompt only for a set of sensitive commands. The risk is documented instead, in phase 8.
- "Treat every unknown command name as sensitive" would make the prompt fire on nearly every command.
- "Append-only audit log" was not requested. The ring buffer and the panel already show everything the model sent.

### Whole-Plan Consistency Sweep
- Searched all plan files for superseded terms: `pidfile`, `--token-file`, `--rotate-token`, `tty?`, `name?`, `Open in terminal`, `focusTerminalSession`, `version(9)`, `terminal` table, `blocked-by-browser`, `unreachable` status, `resolveCommandApproval`, `rate-limit`, `4003`, `taskkill`. The only remaining mentions are the explicit "dropped" or "removed" notes and the Red Team table.
- `plan.md` decisions, success criteria and dependencies match phases 1–8.
- No unresolved contradictions.

## Validation Log

### Session 1 — 2026-09-29
Questions asked: 8.

1. **Red-team findings.** Apply all 15.
2. **Same-origin previews.** Opaque while a bridge is paired.
3. **Token.** New on each start, re-pair through the link.
4. **Editing mode.** Same as Full access: only sensitive commands ask.
5. **Vault lock.** Sessions keep running and reattach.
6. **Platforms.** macOS and Linux. Windows exits as unsupported.
7. **Persisted Allow.** Runs even sensitive commands without asking. This overrides the recommended option, and the phase 5 table and README reflect it.
8. **License.** MIT.

User addition during validation: a deeplink printed by the bridge opens the browser tab, and unlocking the vault connects immediately with no confirm dialog. Applied to phases 2, 4 and 8.

### Verification Results
- Claims checked:
  - Every file path and symbol cited in phases 1–8. This includes the red-team fact checks and a final existence check of every new path cited after the rewrite.
  - The earlier failures: the CSP `ws:` source, the preview sandbox origin, and wrong call-site lines. All three were fixed in the rewrite.
- Failed: 0. Unverified: 2.
- Tier: Full.
- Unverified:
  - `pkill -s <sid>` behaves the same on macOS and Linux. Phase 3 tests this on both.
  - Chrome's `loopback-network` permission name for `navigator.permissions.query`. Phase 4 feature-detects it, and a failed query falls back to the `/health` probe.

### Whole-Plan Consistency Sweep
- The persisted-Allow rule is consistent across plan.md, phase 5 and phase 8 (scenario 3 and the README note).
- The deeplink flow is consistent across phase 2 (`/pair`), phase 4 (fragment capture, auto-connect after unlock, save only after `hello`) and phase 8 (README, e2e scenario 9).
- No contradictions remain.

## Implementation Log (2026-09-29)

All eight phases are implemented. At the end of the session, `pnpm test` (2030 passed, 1 skipped), `pnpm bridge:test` (340), `pnpm lint`, `npx tsc -b` and the bridge typecheck were green. The bridge suites also pass on Linux (`node:24` in Docker).

Still open:
- `pnpm build`, the production bundle check. It waits for the user's OK.
- The manual browser smoke test from phase 8, done by the user.

The packed tarball was checked on macOS and Linux:
- It installs with `npm i --ignore-scripts`.
- It starts and reports `exec,pty,classify`.

### Deviations from the plan
- **Kill.** macOS `pgrep` and `pkill` have no `-s`, and `ps` reports session id 0 there, so the unverified assumption failed.
  - Instead, the kill snapshots the process table with `ps` before sending any signal. It matches by session id on Linux, by descendants, by process groups, and by the PTY tty (first snapshot only).
  - Model interactive shells also run `-l -O huponexit`.
- **Model interactive shells run with history off** (`+H +o history`, `HISTSIZE=0`). This came from the code review.
- **`terminal_write` checks are pinned to the tracker state.** `classifyInput` returns an input version. The bridge refuses any model input whose version changed or is missing (`stale_input`); the tool reports this as `conflict`.
- **`ensureBound` runs before the persisted-Allow shortcut,** so a disconnected bridge is never approved. Classification also runs before the Allow shortcut, so the input version is captured.
- **The classifier is stricter than planned.** Variable, glob and brace expansion in arguments all ask. So do nested shells, deferred code (`trap`, `alias`, `bind`), detaching commands (`setsid`, `tmux`), and a wider set of wrappers and inline-code flags.
- **Root mismatch is refused at approval** as `denied: Terminal unavailable: …different folder`, not as a `path_rejected` tool result.
- **Sandbox workers delete more globals:** `WebSocketStream`, `Worker` and `SharedWorker`, in addition to `WebSocket`, `EventSource` and `WebTransport`.
- **The bridge no longer opens a browser by default** (user, 2026-09-29). It prints the pairing link, and `--open` opts in. This replaces `--no-open`.
- **Tests.** The phase-5 `harness-e2e` case is covered by `src/terminal/terminal-e2e.test.ts`, which has ten scenarios. Bridge-backed app tests use `tsconfig.node-tests.json`.

### Review
- [code-reviewer report](../reports/code-reviewer-260929-2132-terminal-bridge.md): C1, C2, H1, H3 and M1–M4 are fixed and verified by a second review.
- **H2 (preview isolation) is partly addressed.** The iframe remounts when the pairing state changes. A same-origin preview opened before pairing can still keep code in the parent page, and closing that fully needs a product decision.
