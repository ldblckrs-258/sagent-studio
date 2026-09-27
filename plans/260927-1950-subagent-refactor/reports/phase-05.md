# Phase 5 — Agents list redesign

## Status
Completed.

## Files changed
- `src/ui/agent-status.ts` (new): single status vocabulary — `STATUS_TINT`,
  `STATUS_DOT`, `isRunning`, `elapsed(startedAt, endedAt, now)`,
  `activityOf(messages, status)`, `toolCallCount(messages)`. Reads tool parts
  with the AI SDK's `isToolUIPart` / `getToolOrDynamicToolName`, looks up a
  running tool's label in `TOOL_VIEWS` (`src/components/assistant-ui/elements/
  tool-view/registry.tsx`), and falls back to a humanized tool name when a
  tool has no tailored view.
- `src/ui/agent-status.test.ts` (new): covers `elapsed` formatting, `isRunning`,
  `activityOf` for a running tool (registry label and humanized fallback),
  `activityOf` falling back to the last assistant text line, `activityOf`
  ignoring a settled tool's leftover "running" state, and `toolCallCount`.
- `src/ui/panels/agents.tsx`: removed the in-panel detail branch, the
  `AgentFlowView` import, and the local `STATUS_DOT` map. `RunRow` is now a
  three-line row (status icon/label/approval badge, activity, tier chip ·
  tool count · elapsed) with an inline icon-only Stop button. Sections are
  Active (`status === "running" || approvals.length > 0`) and Recent, unchanged
  otherwise. Selecting a row calls `useAgentPanelStore.getState().open(runId)`
  only; there is no local "back" state left, though a small effect still
  returns keyboard focus to a row once `selectedRunId` clears externally, since
  `rowRefs` was already tracking that.
- `src/ui/panels/agents.test.tsx`: rewritten for the new mock shape
  (`messages: UIMessage[]` instead of `events`) and the new behavior — a row's
  activity line, Active grouping for a settled-but-approval-pending run, that
  opening a row only updates the panel store (no inline flow, no textarea),
  and the Stop button located by `aria-label`.

## Requirements check
- Row layout (status icon/label/badge, activity line, tier · tools · elapsed,
  inline Stop): done, per `src/ui/panels/agents.tsx` `RunRow`.
- `activityOf` running-tool label via `TOOL_VIEWS`, fallback last assistant
  text line, settled runs get the final line or empty: done and tested.
- Sections Active (running + awaiting approval) / Recent, empty state kept,
  approvals stay at the top: done.
- Selecting a row opens the shared panel store, no in-panel detail rendering:
  done and tested (`textarea` is asserted absent after a click).
- No code comments in the two new/changed source files: verified by reading
  them back.
- Did not touch `src/ui/panels/agent-flow-view.tsx`, `src/agents/**`,
  `src/chat/**`, `src/session/**`, `src/components/**`, or `src/ui/shell.tsx`.

## Verification
- `pnpm exec vitest run src/ui/panels src/ui/agent-status.test.ts` — 4 files,
  21 tests, all pass (includes the untouched `agent-flow-view.test.tsx`).
- `pnpm exec eslint src/ui/panels/agents.tsx src/ui/agent-status.ts
  src/ui/panels/agents.test.tsx src/ui/agent-status.test.ts` — clean.
- `pnpm exec tsc -b` — 32 pre-existing errors across 15 files (result-envelope
  narrowing issues in `src/tools/builtin/*`, `src/workspace/patch.ts`,
  `src/chat/convert.ts`, `src/chat/plan.ts`, `src/rag/*`, `src/chat/types.ts`,
  `src/ui/file-view/json-view.tsx`); none are in any file this phase touched.
  Did not run `pnpm build` or start the dev server.

## Unresolved questions
- None. One judgment call worth flagging: the phase file's grouping rule
  ("Active: running, and runs awaiting approval") is implemented as
  `status === "running" || run.approvals.length > 0` rather than just the
  running filter, so a run whose status has already settled but still carries
  an unresolved approval (not currently reachable from `approval-queue.ts`,
  which never changes `status`) still surfaces in Active instead of Recent.
  This is defensive/future-proofing rather than a behavior change observable
  today; flagging in case the concurrent runtime work in phases 2–4 ever
  produces that state deliberately.
