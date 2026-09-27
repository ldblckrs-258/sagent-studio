# Phase 5 report: Agents panel master/detail, composer, force-stop

Status: completed.

## What landed

- `src/session/session.ts` — `AppSession` gains `steerAgentRun(runId, text)` and
  `stopAgentRun(runId)`. Both resolve the run's owner from `agentRunStore` and
  delegate to `agentRuntime.steer`/`agentRuntime.stop`, which re-check ownership;
  an unknown or settled run returns `false`. `cancelAgentRun` is unchanged.
- `src/session/session.test.ts` — the two `availableNames` assertions now include
  `read_agent` and `stop_agent` (the Phase 3 gap noted in the Phase 4 report),
  and a new case covers `steerAgentRun`/`stopAgentRun` refusing a non-live run.
- `src/ui/panels/agent-flow-view.tsx` (new) — the detail view. `useFlowItems`
  normalizes a live `AgentRunRecord` (prompt, text deltas, tool calls/errors,
  `user-message` steering) and a settled child thread's messages into one
  `FlowItem[]`. Renders the identity header (label, tier, mode, status, elapsed),
  a markdown assistant timeline, tool chips (failed calls tinted danger), a
  distinct steering bubble, approvals via `AgentApprovalCard`, a forced-stop
  button, and a labelled composer. The composer is enabled only while
  `status === "running"` and disabled with a stated reason otherwise. Sends echo
  optimistically and reconcile against `user-message` events by text, not
  position. Force-stop is optimistic and yields as soon as the store reports a
  non-running status. `STATUS_TINT` and `elapsed` are exported so the panel row
  and the detail header share one vocabulary.
- `src/ui/panels/agents.tsx` — reworked into the two states. `selectedRunId`
  drives list vs detail; the list keeps the live/persisted merge, the elapsed
  timer, and the inline per-row force-stop (optimistic `Stopping…`). Rows are
  real buttons with `aria-current`; the detail back action clears the selection
  and restores focus to the originating row via a ref (no setState-in-effect).
  Stale selections fall back to the list because the detail is shown only while
  the id resolves against live records or the persisted child threads.
- The panel is built for the 280px rail: `min-w-0` throughout, wrapping chip and
  composer rows, `break-words`/`whitespace-pre-wrap` on user text, `truncate` on
  the header label, and 44px (`size="md"`) targets for back/stop/send and the
  selectable row. Existing tokens only; the global `prefers-reduced-motion` rule
  covers the transition.

## Tests

- New `src/ui/panels/agent-flow-view.test.tsx` (jsdom): renders a live flow with
  a tool call and a steering message, enables the composer only while running,
  sends through `steerAgentRun` (button and Enter; Shift+Enter does not send),
  force-stops through `stopAgentRun` and yields once the record is `stopped`,
  disables the composer with a reason when settled, reports no output, and calls
  back.
- Reworked `src/ui/panels/agents.test.tsx` (jsdom): `RunRow` marks the selected
  row with `aria-current`; the panel selects a run, renders its flow, returns to
  the list on back with focus restored to the row, and force-stops a running row.
- `pnpm test` — 133 files, 1542 passed, 1 skipped.
- `pnpm lint` — clean.
- `pnpm build` — clean.

## Notes

- Persisted child transcripts do not currently include steering text: the
  runtime's `transcript()` projects `text-delta`/`tool-call` events only, so a
  reloaded run's flow shows prompt and assistant text but not its later steering
  turns. Live steering renders from the event log. Fixing persistence is out of
  this phase's file ownership (`src/agents/runtime.ts`).

## Next steps

- Phase 6 renders the settled sub-agent report inline in the parent transcript.
- Phase 7 documents the three control tools and adds end-to-end coverage.
