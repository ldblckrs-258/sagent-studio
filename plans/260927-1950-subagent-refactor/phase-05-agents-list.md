---
phase: 5
title: Agents list redesign
status: done
---

# Phase 5 — Agents list redesign

## Goal

The Agents rail answers "what is each agent doing right now" at a glance, and
opens a run full-width.

## Files

- Modify: `src/ui/panels/agents.tsx`
- Add: `src/ui/agent-status.ts` (one status vocabulary: tint, dot, label, icon;
  replaces the duplicated `STATUS_DOT` / `STATUS_TINT`)
- Tests: `src/ui/panels/agents.test.tsx`

## Steps

1. Create `agent-status.ts` and use it in the list and the run view header.
2. Add `activityOf(messages)`:
   - For a running tool part, return that tool's view label from `TOOL_VIEWS`
     ("Listing src…").
   - Otherwise return the last assistant text line, trimmed.
   - For a settled run, return the final text line or error.
3. Row layout:
   - Line 1: status icon (spinner when running), label, and a pending-approval
     badge.
   - Line 2: activity, one line, faint.
   - Line 3: tier chip · N tools · elapsed.
   - The whole row opens the run. A running row keeps an inline Stop icon
     button.
   - The selected row is highlighted while its run view is open.
4. Sections: Active (running, and runs awaiting approval) and Recent. Keep the
   empty state.
5. Approvals stay at the top of the rail, labelled with their run.

## Validation

- Tests for activity text in the running tool, streaming text, and settled
  states.
- Tests for grouping, the approval badge, stop, and that opening a row calls
  `open(runId)`.
- `pnpm exec vitest run src/ui/panels` passes.
