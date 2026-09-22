---
phase: 5
title: "Agents panel master/detail, composer, force-stop"
status: pending
priority: P1
effort: 1.5d
dependencies: [1, 2, 4]
---

# Phase 5: Agents panel master/detail, composer, force-stop

## Goal

Let the user click an agent in the panel to open its live flow, steer it with a
composer, force-stop it, and return to the list.

## Overview

The panel becomes a two-state surface: a list of runs (live and persisted) and a
detail view of one selected run. The detail view shows the real flow as a
message-and-tool timeline, renders markdown, offers a composer while the run is
running, and carries a force-stop action. `AppSession` gains `steerAgentRun` and
`stopAgentRun` so the panel talks to the runtime the same way it already calls
`cancelAgentRun`.

## Key Insights

- **One source of truth for the list.** Live runs come from `agentRunStore` (via
  `useRegistryVersion`), settled runs from `listAgentRuns`. The detail view must
  read the live record when present and fall back to the persisted child thread,
  exactly like the list already merges them.
- **Flow is event-shaped.** A live record's `events` already include text deltas,
  tool calls, tool results, errors, approvals, and (from Phase 1) user steering
  messages. Persisted runs expose `thread.messages` instead. Normalize both into
  one `FlowItem[]` (`user` | `assistant` | `tool`) for rendering.
- **Steering is only valid while running.** Disable the composer otherwise and
  say why; do not offer it on a settled run.
- **Force-stop is optimistic.** Stop aborts the controller; the run settles
  asynchronously. Show a stopping state until the store reports `stopped`.
- **Accessibility.** Selection is a real button with `aria-current`; the detail
  view has a labelled back button; the composer is a labelled textarea with
  Enter-to-send and Shift+Enter for a newline; focus returns to the list row on
  back.

## Requirements

- `AppSession` (and `session.ts`) gains `steerAgentRun(runId, text): boolean` and
  `stopAgentRun(runId): boolean`, delegating to the runtime.
- `AgentsPanel` holds `selectedRunId`; clicking a row selects, a back action
  clears it.
- A new `AgentFlowView` renders the selected run: identity header (label, tier,
  mode, status, elapsed), the flow timeline, approvals inline, a composer, and a
  force-stop button while running.
- The list keeps inline per-row force-stop for running runs.
- Empty, loading, stopped, errored, and no-output states are all handled.
- The panel remains usable at the rail's minimum width (no horizontal scroll).

## Files to Create / Modify

- Modify: `src/session/session.ts` (`steerAgentRun`, `stopAgentRun`)
- Modify: `src/session/session.test.ts`
- Modify: `src/ui/panels/agents.tsx`
- Modify: `src/ui/panels/agents.test.tsx`
- Create: `src/ui/panels/agent-flow-view.tsx`
- Create: `src/ui/panels/agent-flow-view.test.tsx`

## Implementation Steps

1. Add `steerAgentRun` and `stopAgentRun` to `AppSession` and implement them in
   `createSession`, delegating to `agentRuntime.steer`/`agentRuntime.stop` with
   ownership already enforced by the runtime.
2. Create `agent-flow-view.tsx`:
   - a `useFlowItems(runId)` normalizer for live records and persisted threads;
   - the header, timeline (markdown for assistant text, chip rows for tool
     calls, a distinct bubble for user steering messages), and approvals
     (`AgentApprovalCard`);
   - a composer wired to `session.steerAgentRun`, disabled unless running, with
     optimistic echo of the sent message;
   - a force-stop button wired to `session.stopAgentRun`.
3. Rework `panels/agents.tsx` into the two states, keeping the live/persisted
   merge and the timer for elapsed time; pass the selected run to
   `AgentFlowView`; keep the inline force-stop on running rows.
4. Wire the real app session methods through `useSession()` (the session context
   already returns the whole `AppSession`, so no context change is needed).
5. Tests: `agent-flow-view.test.tsx` renders a live flow with a tool call and a
   steering message, enables the composer only while running, and calls
   `steerAgentRun`/`stopAgentRun`. `agents.test.tsx` covers select, render detail,
   and back.

## Verification

- `pnpm test src/ui/panels/agent-flow-view.test.tsx src/ui/panels/agents.test.tsx src/session/session.test.ts`
- `pnpm lint && pnpm build`

## Success Criteria

- Clicking a run opens its flow; back returns to the list.
- A running run's composer sends a steering message that appears in the flow and
  reaches the runtime.
- Force-stop moves the run to `stopped` and disables the composer.
- The panel works at the minimum rail width with no horizontal scroll.

## Risk Assessment

- **Stale selection:** a selected run can settle or be removed; fall back to the
  list when the id no longer resolves.
- **Optimistic echo drift:** the store is authoritative; reconcile the optimistic
  message with the `user-message` event by run and text, not by position.

## Security Considerations

- The composer sends only text through the existing runtime path; it cannot
  change mode, tools, or approvals.
- No new persistence surface; steering text is stored in the existing child
  thread.

## Next Steps

- Phase 7 documents the tools and adds end-to-end coverage.
