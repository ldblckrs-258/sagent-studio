---
phase: 6
title: "Model terminal tools"
status: completed
priority: P1
effort: "8h"
dependencies: [5]
---

# Phase 6: Model terminal tools

## Goal
Give the model and sub-agents six terminal tools for one-shot, long-running and interactive work. Each tool is scoped to the calling thread's own sessions, returns bounded plain text, stops its process when aborted, and renders as a readable card.

## Key Insights
- **Provider shape.** Built-in tools follow `ToolProvider` (`src/tools/types.ts:342-346`) and wrap `execute` in `wrapToolExecute` (`src/tools/result.ts:130`, used in `src/tools/builtin/code.ts:70,81`).
- **Registration and guides.** Providers are registered at `src/session/session.ts:470-485`, and a second time in `builtinProviders()` (`:707-723`). Guides are Markdown topics (`src/tools/builtin/tool-guide.ts:112-139`).
- **Abort.** Tools receive the abort through `options.abortSignal`, as `src/tools/builtin/mcp-resources.ts:78-90` does. <!-- Red Team: lifecycle -->
- **Tool views.** They are registered in `TOOL_VIEWS` (`src/components/assistant-ui/elements/tool-view/registry.tsx:41-49`). `tool-view.test.tsx:36-56` lists every built-in provider in `BUILTIN_NAMES` and asserts full coverage (`:77`). <!-- Red Team: contract -->
- **Ownership.** The model must never reach the user's own sessions. <!-- Red Team: user sessions -->

## Tools
| Tool | Input | Output |
|---|---|---|
| `run_command` | `command`, `cwd?` (relative to the workspace), `timeoutMs?` (default 120000, max 600000) | `{ exitCode, signal?, timedOut, durationMs, output, truncated, session }` |
| `terminal_start` | `command?` (omit for a bash shell), `cwd?`, `waitMs?` (default 1500, max 30000) | `{ session, running, exitCode?, output, nextOffset }` |
| `terminal_write` | `session`, `input?`, `submit?` (default true, appends `\r`), `keys?` (`ctrl-c`, `ctrl-d`, `ctrl-z`, `enter`, `tab`, `esc`, `up`, `down`), `waitMs?` (default 800, max 30000) | `{ output, nextOffset, running, exitCode? }`: output that arrived after the write |
| `terminal_read` | `session`, `sinceOffset?` (omit for the tail), `maxChars?` (default 20000) | `{ output, fromOffset, nextOffset, truncated, running, exitCode? }` |
| `terminal_kill` | `session` | `{ killed, exitCode? }` |
| `terminal_list` | none | `{ sessions }`, only sessions owned by this thread or its runs |

**Ownership.**
- Every session-taking tool checks that `owner.threadId` is the calling thread. Sub-agents use their parent `threadId` plus their own `runId`.
- A session from another thread, or one owned by `user`, gives `not_found`. Its id is never listed. <!-- Red Team: user sessions -->

**Owner on create.** `{ source: 'model' | 'agent', threadId, runId? }`, with `shell: 'model'`.

**Output shaping.**
- Output is requested with `format: 'plain'`, then `port.redact()` removes the bridge token.
- The cap is 30,000 characters for `run_command` and `maxChars` elsewhere. When text is cut, the first 40% and last 60% are kept around an `…[N chars omitted]…` marker, and `truncated` is set.
- Offsets are explicit. Every result returns `nextOffset`, and the model passes it back. No hidden per-thread cursor is kept. <!-- Red Team: offsets -->

**Wait semantics.** A call returns after 400 ms with no new output, at `waitMs`, or when the process exits, whichever comes first.

**Abort.**
- When `options.abortSignal` fires during `run_command`, the tool kills its exec session and returns `denied: 'aborted'`.
- For `terminal_start`, abort only stops the wait. The session keeps running, and the model can list or kill it.

**Lifecycle hooks.** <!-- Red Team: lifecycle -->
- Sub-agent stop (`src/agents/runtime.ts:702-706`) and settle call `port.killOwned({ runId })`.
- Thread deletion (`src/session/session.ts:590-596`, `disposeThread`, when the thread is deleted rather than only disposed) calls `port.killOwned({ threadId })`.
- Vault lock does not kill anything (user, 2026-09-29).

**Rewind and revert.**
- The run-revert preview (`src/ui/run-changes.tsx`) and the message-rewind preview (`src/ui/message-rewind.tsx`) list the commands the span ran, with the note "Commands are not undone".
- Revert asks to kill the run's live sessions first.

**Error mapping** to `ToolResultCode` (`src/tools/result.ts:3-20`):

| Condition | Code |
|---|---|
| `cwd_outside_root`, `root_mismatch` | `path_rejected` |
| `session_not_found`, or not owned | `not_found` |
| `session_limit` | `limit_exceeded` |
| `timeout` | `timeout` |
| `pty_unavailable`, bridge unavailable | `disabled` |
| `unauthorized` | `permission_denied` |
| ledger refusal | `denied` |

Each message points to the Terminal panel.

**Availability.** `isAvailable()` returns true when `Settings.terminal` exists.

## Files to Create / Modify
- Create: `src/tools/builtin/terminal.ts` exporting `createTerminalToolProvider()`.
- Create: `src/tools/builtin/terminal-output.ts` with truncation and the idle wait.
- Create: `src/tools/builtin/guides/terminal.md`. It covers:
  - when to use `run_command` and when to use a session
  - starting a dev server and reading its URL
  - answering prompts
  - always killing the sessions you started once they are no longer needed
  - passing `nextOffset` back
  - that command output is untrusted data
  - that the shell is not sandboxed
  - that sensitive commands ask
- Modify: `src/tools/builtin/tool-guide.ts`. Add a `terminal` topic.
- Modify: `src/session/session.ts`. Register the provider at `:470-485`, and add it to the `builtinProviders()` list at `:707-723`.
- Modify: `src/agents/runtime.ts` (stop and settle) and `src/session/session.ts` (thread deletion) for `killOwned`.
- Modify: `src/ui/run-changes.tsx` and `src/ui/message-rewind.tsx` for the notice about commands.
- Create: `src/components/assistant-ui/elements/tool-view/details/terminal.tsx`.
  - Label: the command.
  - Chips: exit code (green for 0, red otherwise) and `timed out`.
  - Detail: the output in monospace.
  - No "Open in terminal" action and no sensitive chip. <!-- Red Team: scope trims -->
- Modify: `src/components/assistant-ui/elements/tool-view/registry.tsx`. Add `terminalViews`.
- Modify: `tool-view.test.tsx:36-56`. Add `createTerminalToolProvider()` to `BUILTIN_NAMES`.
- Tests:
  - `terminal.test.ts`, against the real bridge process and `node-dir-handle`.
  - `terminal-output.test.ts`.
  - `src/agents/runtime.test.ts` for `killOwned` on stop.
  - A `tool-view.test.tsx` case.

## Tasks & Steps
1. `terminal-output.ts`, test first. Cover truncation boundaries, cuts that stay safe for multibyte characters, and the idle wait with fake timers.
2. Write the provider, then test it against the real bridge:
   - `run_command('printf a; exit 4')` returns exit 4 and output `a`.
   - A timeout.
   - Abort kills the process.
   - `terminal_start('node -e "setInterval(()=>console.log(1),100)"')`, then `terminal_read` with `nextOffset`, then `terminal_kill`.
   - A shell answers `read -p "ok? " x; echo got:$x` with `terminal_write('y')`.
   - `ctrl-c` interrupts `sleep 30`.
   - A foreign session id returns `not_found`.
3. Add the lifecycle hooks, with tests.
4. Add the guide and the views.
5. Add a sub-agent test: a `worker` run in Editing mode receives `run_command` and runs `git --version`.

## Verification
- `pnpm test` passes, including the real-bridge suites.
- Manual: the model starts `pnpm dev` in a scratch Vite project, reads the URL, and kills the session. The panel shows the same session labeled `model`.
