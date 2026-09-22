---
phase: 2
title: "Runtime control surface and parent notices"
status: pending
priority: P1
effort: 1d
dependencies: [1]
---

# Phase 2: Runtime control surface and parent notices

## Goal

Expose steer, stop, and read through the agent runtime and the parent-scoped
agent port, and deliver a `stopped` notice with its reason to the parent
conversation.

## Overview

The runtime already owns per-run AbortControllers. Phase 1 added steering and
stop state to the store; this phase wires the runtime's public API to it, extends
`AgentSpawnPort`, and makes the child-thread snapshot and the parent notice carry
the stop reason.

## Key Insights

- **Ownership is the boundary.** `AgentRuntime` tracks `parents` (runId →
  parentThreadId). `stop`, `steer`, and `read` must resolve a run and verify it
  belongs to the calling context's parent thread before acting, so one
  conversation cannot control another's agent.
- **One persistence shape.** `snapshotOf` builds the child thread; `stopReason`
  must be part of `AgentRunSnapshot` → `AgentThreadMeta` so a reload shows a
  stopped run correctly.
- **Notice text stays model-visible.** `appendAgentNotice` receives a
  human-readable string plus a structured `report`. Add the stop reason to the
  report and word the string so the model sees why the agent stopped.
- **Reading needs both sources.** A live run is in `agentRunStore`; a settled run
  is a persisted child thread loaded via `threadStore.loadThread`. `read` checks
  live first, then persistence.

## Requirements

- `AgentRuntime` gains `steer(runId, text): boolean`,
  `stop(runId, reason?): boolean`,
  `read(runId, options?): Promise<AgentTranscript | null>` (async: a settled run
  loads from persistence), and `resolveRun(identifier): Promise<AgentRunIdentity | null>`
  where `identifier` is `{ runId?: string; label?: string }`.
- `AgentTranscript` is `{ runId; label?; status; stopReason?; turns: AgentTurn[] }`
  where an `AgentTurn` is `{ role: 'user' | 'assistant' | 'tool'; text; toolName? }`.
- `read` enforces parent ownership, supports `lastN` (1..50, default 6) and an
  `includeTools` flag, and returns newest turns first or oldest-first per a fixed
  contract documented in the tool schema.
- `resolveRun` searches live runs then persisted children, both parent-scoped,
  and returns null for no match or an ambiguous label; the tool layer turns null
  into `invalid_input`.
- `tools/types.ts` `AgentSpawnPort` gains `steer`, `stop`, `read`, and
  `resolveRun`, each parent-scoped.
- `session.ts` `agentPortsFor` binds the new methods to `context.parentThreadId`.
- `onSettle` words a `stopped` notice with reason `user_stop` and includes
  `stopReason` in the report.
- `AgentRunSnapshot` and `agentThreadFrom` carry `stopReason`.

## Files to Create / Modify

- Modify: `src/agents/runtime.ts` (steer/stop/read, ownership, snapshot reason)
- Modify: `src/agents/runtime.test.ts`
- Modify: `src/agents/types.ts` (transcript types)
- Modify: `src/tools/types.ts` (`AgentSpawnPort` extension)
- Modify: `src/session/session.ts` (`agentPortsFor`, `onSettle`, snapshot)
- Modify: `src/session/session.test.ts`

## Implementation Steps

1. Add `AgentTranscript`, `AgentTurn`, and `AgentReadOptions` to
   `src/agents/types.ts`.
2. In `src/agents/runtime.ts`:
   - `steer(runId, text)`: resolve the controller and ownership from `parents`;
     call `deps.store.steer(runId, text)`; return whether the run is live.
   - `stop(runId, reason = 'user_stop')`: verify ownership; call
     `deps.store.requestStop(runId, reason)` then `controller.abort()`; return
     whether it stopped.
   - `read(runId, options)`: verify ownership; read the live record events or load
     the persisted child thread; project to `AgentTurn[]`; apply `lastN` and
     `includeTools`. Async, because persistence is async.
   - `resolveRun(identifier)`: verify ownership; match the live store first, then
     persisted children; require an exact unique `runId` or a unique `label`.
3. Extend `AgentSpawnPort` with the four methods and implement them in
   `session.ts` `agentPortsFor`, delegating to `agentRuntime` with the closure's
   `context.parentThreadId` as the ownership guard.
4. Add `stopReason` to `AgentRunSnapshot`, populate it in `snapshotOf`, and add it
   to `AgentThreadMeta` in `agentThreadFrom`.
5. In `onSettle`, when `run.result?.status === 'stopped'`, set the notice text to
   name the user stop and pass `stopReason` through the report.
6. Tests: `runtime.test.ts` asserts ownership rejection across parents, stop
   propagation to the store, and `read` over live and persisted runs with `lastN`
   clamping. `session.test.ts` asserts the port methods are wired.

## Verification

- `pnpm test src/agents/runtime.test.ts src/session/session.test.ts`
- `pnpm lint && pnpm build`

## Success Criteria

- A stop via the port aborts the run and yields `stopped` + `user_stop`.
- `read` cannot cross parent boundaries and honours `lastN`.
- `resolveRun` rejects an ambiguous label.
- A parent `stopped` notice names the user stop.

## Risk Assessment

- **Persistence race:** a settled run may be mid-save when `read` loads it; the
  live store is checked first, and a lock yields null rather than throwing.
- **Ownership bypass:** every method repeats the parent check; do not rely on the
  port closure alone for the model-facing tools (Phase 3 re-checks).

## Security Considerations

- Reads are restricted to the caller's own child runs; no cross-conversation
  disclosure.
- Stop and steer are idempotent and cannot affect already-settled runs.

## Next Steps

- Phase 3 turns the port into model-callable tools.
