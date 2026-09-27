---
title: Agent panel steering and control shipped
date: 2026-09-23
summary: "Implemented the seven-phase agent-panel-steering plan (steering, stop semantics, stop_agent/read_agent, markdown, master/detail panel, inline notices, docs), then a review-driven hardening pass and a UI refactor reusing the main-thread conversation display; all gates green."
---

# Agent panel steering and control shipped

## What happened

Implemented `plans/260922-1950-agent-panel-steering` end to end, then applied a
code-review remediation pass and a post-implementation UI refactor.

- **Steering runtime**: `runAgent` wraps `streamText` in an outer continuation
  loop, injects queued user turns through `prepareStep`, accumulates response
  messages and usage across passes, and caps total steps and steers. `stopped`
  plus `AgentStopReason` are distinct from a system `aborted`.
- **Control surface**: `AgentRuntime.steer/stop/read/resolveRun` are all
  parent-scoped; `AgentSpawnPort` gained the same methods; `read` is async and
  projects an `AgentTranscript` with `lastN` clamping.
- **Tools**: `stop_agent` and `read_agent` join `spawn_agent`, resolve a unique
  `runId`/`label`, bound their output, mark reads untrusted, and stay out of a
  sub-agent's toolset via `BLOCKED_AGENT_TOOLS`.
- **Inline notices**: `appendAgentNotice` writes immediately as a
  `data-agent-notice` part on the in-flight assistant message; the run loop
  updates that message in place by id so the notice survives chunks and reloads.
  `stopReason` now round-trips through persistence.
- **Panel**: master/detail Agents panel with a live flow, composer, and
  force-stop; markdown everywhere sub-agent text renders.

## Problems found and fixed

An independent `code-reviewer` pass found real defects, all fixed with a
regression test per fix:

1. **High: inline notices were not model-visible.** The inline notice carried no
   text part and `convertToModelMessages` dropped the data part. Fixed with
   `convertAgentNoticePart` wired as `convertDataPart` in the run path and in
   compaction.
2. **Medium: `read_agent` tool-turn parity.** Persisted transcripts rendered tool
   calls as `[called X]` text. `transcript()` now emits real `dynamic-tool` parts.
3. **Medium: silent steer swallow.** `steer` can be accepted but never drained
   at a budget/step cap; a `close()`/`accepting()` channel plus derived optimistic
   state now retire a phantom echo.
4. **Medium: history continuity.** `prepareStep`-injected turns were missing from
   later-pass model history; they are now accumulated into `history`.
5. **Medium: unbounded read.** Added an aggregate `read_agent` output cap.

A separate plan overlap was also removed: both the store and the runner recorded
the steering `user-message` event, duplicating the turn. The runner is now the
single writer (recorded at drain, the chronological injection point).

## UI refactor (post-implementation request)

The Agents list and flow view looked unlike the rest of the app. Introduced
`src/ui/conversation.tsx` as the one conversation vocabulary (`UserBubble`,
`AssistantProse`, `ToolCallRow`, `COMPOSER_SHELL`), adopted it in the panel and
in the main thread's user turn and composer shell, sectioned the list
(Active/Recent), and added an **Open in panel** action on sub-agent tool calls
that selects the run through `src/session/agent-panel-state.ts`.

## Verification

`pnpm test` (134 files, 1557 passed, 1 skipped), `pnpm lint`, and `pnpm build`
all green. New tests cover steering injection, stop semantics, read/write tools,
inline-notice survival, and the panel jump from a tool call.

## Next steps

- Optional desktop polish: a live visual pass of the panel against a running
  vault; the refactor was verified by tests and static review.
- `AgentSpawnPort` control methods remain optional (capability probe), guarded by
  the tools; making them required is a possible follow-up.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
