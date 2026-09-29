---
phase: 5
title: "Approval gate for commands"
status: completed
priority: P1
effort: "7h"
dependencies: [3, 4]
---

# Phase 5: Approval gate for commands

## Goal
Decide each terminal tool call from the command's classification, inside the approval function. Sensitive commands ask, with their reason shown next to the command. Safe commands run. An unbound or disconnected bridge never fails open. The same rule applies in the main chat and in sub-agents.

## Key Insights
- **Existing gate.** The gate resolves by tool name only, through `resolveApprovalStatus` (`src/tools/approval.ts:184-200`). The main chat builds a static map from it (`src/chat/approval.ts:11-22`, `src/chat/engine.ts:507`). The runner already uses an async function (`src/agents/runner.ts:197-211`).
- **SDK hook.** An SDK map value may be a `SingleToolApprovalFunction(input, options)` (`node_modules/ai/dist/index.d.ts:3060-3063,3111`). `options` carries the `toolCallId`. It has no `abortSignal`, so every bridge request made from it needs its own timeout.
- **Resume re-runs approval.** On resume the SDK calls the approval function again, and only `denied` blocks the call there (red-team flow trace, `node_modules/ai/dist/index.js:5638-5716`).
- **Reason display already exists.** `requestReason` is mapped to `prompt` in `src/chat/approval-pending.ts:38-47`. `ApprovalPrompt` renders it (`src/ui/approval-prompt.tsx:51-60`), and so does `ToolFallbackApproval` (`tool-fallback.aui.tsx:478-480`). Only the command has to be added beside it. <!-- Red Team: reason UI reuse -->
- **Fail-open.** Binding happens lazily, so returning `approved` while unbound let `execute` bind and run. Binding and classification must happen in the approval function. <!-- Red Team: fail-open -->

## Policy (user, 2026-09-29)
| Mode | Safe command | Sensitive command | Persisted `deny` | Persisted `ask` | Persisted `allow` |
|---|---|---|---|---|---|
| Read-only | ask (above ceiling) | ask | denied | ask | runs |
| Editing | runs | ask | denied | ask every call | runs, even when sensitive |
| Full access | runs | ask | denied | ask every call | runs, even when sensitive |

**Tool sets:**
- `terminal_read` and `terminal_list` join `READ_ONLY_TOOLS`.
- `run_command`, `terminal_start`, `terminal_write` and `terminal_kill` join `EDITING_TOOLS`, `GATED_BUILTINS` and `MODE_GRANTED_TOOLS`. With that, the base status in Editing is `approved`, and Editing-mode sub-agents receive the tools. <!-- Red Team: ceiling -->
- `COMMAND_TOOLS = { run_command, terminal_start, terminal_write }`.

**`commandApprovalFor(port, ctx, name, input, toolCallId)`**, where `ctx` is `{ threadId, runId?, mode, settings }`:
1. Compute `base = resolveApprovalStatus(mode, settings, { name })`.
2. If `base === 'denied'`, return `denied`.
3. If the persisted decision is `allow`, record the call and return `approved`.
4. `await port.ensureBound(threadId)` (5 s timeout). On failure, return `{ type: 'denied', reason: 'Terminal unavailable: <reason>' }`. Nothing runs, and the model gets the reason.
5. Classify:
   - `run_command` and `terminal_start` with a command: `classify(command)`.
   - `terminal_start` without a command: not sensitive, because every submitted line is classified later.
   - `terminal_write`: the target session must be owned by `threadId` or its runs, or return `denied: 'not your session'`. Then call `classifyInput(session, input, keys, submit)`.
   - Any classify error or timeout gives `{ type: 'user-approval', reason: 'Could not classify command' }`.
6. Command lane: if an earlier command call in this thread's current step is still waiting for approval, return `{ type: 'user-approval', reason: 'Runs after an earlier command awaiting approval' }`. This prevents order inversions such as `rm -rf dist` waiting while `pnpm build` runs. <!-- Red Team: ordering -->
7. If the command is sensitive, return `{ type: 'user-approval', reason: 'Sensitive: <reasons>' }`.
8. Otherwise return `base`, which is `approved` in Editing and Full access and `user-approval` in Read-only.
9. Record `{ toolCallId, command/input, epoch }` in the port's approval ledger whenever the result is not `denied`.

**`execute` check.** Every `COMMAND_TOOLS` execute looks up its `toolCallId` in the ledger. It refuses with `denied` when the entry is missing, when the input differs, or when the connection epoch has changed since approval. This closes the gap between the approval check and execution.

## Files to Create / Modify
- Modify: `src/tools/approval.ts`. Add the set memberships and export `COMMAND_TOOLS`. `resolveApprovalStatus` stays unchanged. <!-- Red Team: compose, not fork -->
- Create: `src/terminal/approval.ts`. `commandApprovalFor`, the per-thread command lane, and the approval ledger (`record`, `consume`).
- Modify: `src/chat/approval.ts`. `createToolApproval(mode, settings, tools, command?)`, where the optional `command: { port, threadId }` emits a `SingleToolApprovalFunction` for each `COMMAND_TOOLS` name in the tool set.
- Modify: `src/chat/engine.ts:507`. Pass `{ port: deps.terminal, threadId }` when `deps.terminal` exists.
- Modify: `src/agents/runner.ts:197-211`.
  - For `COMMAND_TOOLS`, call `commandApprovalFor` with `{ threadId: parent thread, runId }`.
  - Send a `user-approval` to `deps.queue.request({ …, reason })`.
  - Map `denied` straight through.
- Modify: `src/agents/approval-queue.ts:10-22,84-92`. Add an optional `reason` to the request and copy it into the pending entry.
- Modify: `src/ui/agent-approval.tsx`. Show the reason and the command.
- Modify: `src/ui/approval-prompt.tsx:51-60`. For command tools, show both the command with its cwd in monospace and the reason, instead of letting the prompt replace the input.
- Modify: `src/ui/panels/approvals.tsx`. No grouping. The gated terminal tools appear as ordinary rows, with a one-line note: "Allow runs sensitive commands without asking." <!-- Red Team: scope trims -->
- Tests:
  - `src/tools/approval.test.ts`: set memberships and the base status per mode.
  - `src/terminal/approval.test.ts`: every row of the policy table, plus these cases:
    - an unbound or disconnected bridge gives `denied`
    - a classify timeout gives `user-approval`
    - writing to someone else's session gives `denied`
    - the lane
    - a ledger mismatch at execute
  - `src/chat/approval.test.ts`: functions are emitted only for command tools.
  - `src/agents/runner.test.ts`: a sensitive sub-agent command queues a request with its reason, a safe one does not, and an Editing-mode `worker` has `run_command` in its pool.
  - `src/ui/agent-approval.test.tsx`: the reason renders.
  - `src/chat/approval-pending.test.ts`: `requestReason` flows through to `prompt`.

## Tasks & Steps
1. Add the set memberships, and write the ceiling and base-status tests.
2. Write `commandApprovalFor`, the lane and the ledger, test first, against a fake `TerminalPort`.
3. Wire the engine and the runner.
4. Update the queue and the approval UIs.
5. Run `pnpm test`.

## Verification
- All the tests above pass.
- A new `harness-e2e.test.ts` case: a scripted model runs `run_command('rm -rf dist')` in `god` mode against a real bridge.
  - The run pauses with a `user-approval` whose reason contains `recursive delete`.
  - Denying it leaves `dist` in place and nothing is spawned (checked with the bridge `list`).

## Security Considerations
- The classifier is a prompting aid, not a boundary. The README says so, along with the fact that persisted `allow` turns prompting off.
- The model cannot influence classification. The input schemas have no risk field, and classification runs in the bridge.
