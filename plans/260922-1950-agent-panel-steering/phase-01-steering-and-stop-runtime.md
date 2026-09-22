---
phase: 1
title: "Steering and stop runtime"
status: pending
priority: P1
effort: 1.5d
dependencies: []
---

# Phase 1: Steering and stop runtime

## Goal

Give a running delegated agent a real mid-run injection point and a distinct
user-stop outcome, inside the runner and the run store.

## Overview

`runAgent` currently calls `streamText({ prompt, stopWhen: stepCountIs(N) })`
once. To steer it live, wrap the call in an outer loop that re-invokes
`streamText` while steering messages remain, and inject queued messages at step
boundaries through the SDK's `prepareStep`. A user stop must be distinguishable
from a system abort, so the runner returns `stopped` with a reason when a stop was
requested, and `aborted` otherwise.

## Key Insights

- **`prepareStep` is the injection point.** `PrepareStepFunction` receives the
  current `messages` and may return a `messages` override that carries forward
  (`node_modules/ai/dist/index.d.ts:1664-1753`). Append the queued user message
  there so it lands at the next step boundary with correct role ordering.
- **Step boundaries do not always come.** An agent that answers in one step
  produces no further step, so `prepareStep` alone can drop a message. The outer
  loop runs another `streamText` pass with the accumulated messages plus the
  pending steering message, which guarantees delivery while the run is live.
- **Response accumulation.** `streamText` exposes `result.response` (a promise of
  `{ messages }`). Push those response messages into the running history so the
  next pass continues the same conversation.
- **Abort is not stop.** The runner's existing `aborted` flag is set by the abort
  signal or an `AbortError`. Add a `stopReason` carried on the steering handle;
  on abort, return `stopped` + reason when the stop was user-requested, else
  `aborted` (unchanged).
- **Event log is the source of the flow.** A steering message is recorded as a
  `user-message` event so the panel and the persisted transcript can show it in
  place.

## Requirements

- `AgentRunStatus` gains `'stopped'`; `AGENT_RUN_STATUSES` and every exhaustive
  status map include it.
- `AgentStopReason = 'user_stop'`; `AgentRunResult.stopReason?`,
  `AgentThreadMeta.stopReason?`, and `AgentNoticeReport.stopReason?` carry it.
- `AgentRunEvent` gains `{ type: 'user-message'; text: string }`.
- `runAgent` accepts a `steering` handle with `drain(): string[]`,
  `stopRequested(): boolean`, and `stopReason(): AgentStopReason | undefined`.
- `runAgent` appends each drained message via `prepareStep` and via an outer
  continuation pass, accumulating assistant text and usage across passes.
- `AgentRunStore` gains `attachSteering(runId, handle)`, `steer(runId, text)`,
  and `requestStop(runId, reason)`; `steer` records the `user-message` event and
  enqueues the text; `requestStop` records the reason and aborts the controller.
- The store's `finish` keeps the runner-provided status and
  `stopReason`, and `remove`/`clear` drop steering state.

## Files to Create / Modify

- Modify: `src/chat/types.ts` (`stopped` status, stop reason on meta/report)
- Modify: `src/agents/types.ts` (stop reason, `user-message` event, steering type)
- Modify: `src/agents/runner.ts` (`prepareStep` injection + outer loop + stopped)
- Modify: `src/agents/runner.test.ts` (steering and stop cases)
- Modify: `src/agents/store.ts` (steering and stop-request state)
- Modify: `src/agents/store.test.ts`
- Modify: `src/components/assistant-ui/elements/sub-agent-report.aui.tsx` (status
  map gains `stopped`; markdown body is Phase 4)
- Modify: `src/ui/panels/agents.tsx` (status tint map gains `stopped`; full panel
  work is Phase 5)

## Implementation Steps

1. In `src/chat/types.ts`, add `'stopped'` to `AgentRunStatus` and its runtime
   guard array; add `AgentStopReason`; add `stopReason?` to
   `AgentThreadMeta` and `AgentNoticeReport`.
2. In `src/agents/types.ts`, add the `user-message` event, the
   `AgentSteeringHandle` interface, `stopReason?` on `AgentRunResult`, and a
   `steering` field on `AgentRunnerDeps`.
3. In `src/agents/runner.ts`:
   - Convert the single `streamText` call into an outer `while (true)` pass.
     Maintain `history: ModelMessage[]` seeded with `{ role: 'user', content: prompt }`.
   - Pass `messages: history` instead of `prompt`, and add
     `prepareStep: ({ messages }) => { const pending = steering.drain(); return pending.length ? { messages: [...messages, ...pending.map(text => ({ role: 'user' as const, content: text }))] } : {}; }`.
   - After each pass, `const { messages: responseMessages } = await result.response`
     and append them to `history`.
   - End the loop when aborted, failed, or `steering.drain()` is empty.
   - On abort, set the final status to `stopRequested ? 'stopped' : 'aborted'`
     and attach `stopReason` when stopping.
   - Emit a `user-message` event for each drained message so the flow records it.
4. In `src/agents/store.ts`, add a `steering` map keyed by `runId` with
   `attachSteering`, `detachSteering`, `steer`, `requestStop`, and a
   `stopRequested(runId)` read. `steer` appends a `user-message` event before
   enqueuing so ordering is deterministic.
5. Keep `MAX_AGENT_STEPS` as the per-pass cap; add a total steering budget
   (`MAX_AGENT_STEERS = 20`) so a user cannot loop a run indefinitely. Track
   total steps across outer passes and stop once the combined cap is reached, so
   an outer pass cannot silently double the step budget.
6. Inject only when the current messages end with a tool result or an assistant
   message; if the tail is otherwise (a partial tool call), hold the pending
   message for the next pass instead of risking an invalid role sequence.
7. Tests: in `runner.test.ts`, a mock model that returns a tool call then a final
   answer, with a steering message pushed between passes, asserts an extra model
   call and the injected user content; a stop-requested abort returns `stopped`
   with `user_stop`; a plain abort still returns `aborted`. `store.test.ts`
   covers `steer` event ordering and `requestStop` reason retention.

## Verification

- `pnpm test src/agents/runner.test.ts src/agents/store.test.ts`
- `pnpm lint && pnpm build`

## Success Criteria

- A steering message enqueued during a run is delivered and answered in the same
  run, and appears as a `user-message` event.
- A user stop yields `status: stopped` + `stopReason: user_stop`; a system abort
  yields `aborted` unchanged.
- The steering budget stops runaway loops.

## Risk Assessment

- **SDK message shape:** confirm `ModelMessage` user messages accept a plain
  string `content` and that `result.response.messages` round-trips. If not,
  convert with the SDK's message helpers.
- **Double counting usage:** `usage` is currently the last pass's `totalUsage`;
  sum across passes or keep the last and document the choice.

## Security Considerations

- Steering text is user-authored and trusted for display, but the runner treats
  it as a normal user turn; it does not widen the toolset, mode, or approvals.
- The store never persists steering text outside the existing thread envelope.

## Next Steps

- Phase 2 exposes `steer` and `stop` through the runtime and the agent port.
