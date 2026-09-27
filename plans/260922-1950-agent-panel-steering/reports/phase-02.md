# Phase 2 report: runtime control surface and parent notices

Status: completed.

## What landed

- `AgentRuntime` gained `steer`, `stop`, `read`, and `resolveRun`, each taking the
  calling `parentThreadId` first and re-checking ownership before acting.
  `read` and `resolveRun` are async; `read` checks the live store first, then
  persistence, and returns null on a cross-parent or absent run.
- `src/agents/types.ts` added `AgentRunIdentifier`, `AgentRunIdentity`,
  `AgentTurn`, `AgentReadOptions`, and `AgentTranscript`.
- `AgentRunSnapshot` carries `stopReason` and `snapshotOf` populates it, so a
  stopped child thread persists its reason.
- `spawn` builds one `AgentSteeringControl` over the run's `AbortController`,
  attaches it via `store.attachSteering(runId, control)`, passes it as
  `runnerDeps.steering`, and detaches it in `cleanup`.
- `AgentSpawnPort` gained the four control methods; `createAgentPorts` in
  `session.ts` binds them to `context.parentThreadId`.
- `agentNoticeFor` (exported from `session.ts`) words a `stopped` notice as
  "stopped by the user" and passes `stopReason` in the report; `onSettle` uses it.
- Persistence read side: `AgentRunPersistence` gained `load(runId)` and
  `list(parentThreadId)`; session implements them over `loadThread` /
  `listAgentRuns` + `rehydrateThread`, mapping back through `agentSnapshotFrom`.

## Read contract

`read` returns turns **oldest-first**. `lastN` selects the most recent N turns,
clamped to 1..50 (default 6); `includeTools` defaults to false. The contract is
documented on `AgentReadOptions` / `AgentTranscript` in `src/agents/types.ts`.

## Ownership

`steer`/`stop` verify `parents.get(runId) === parentThreadId`, so a settled run
(already cleaned out of `parents`) is inert. `read`/`resolveRun` verify the
record/snapshot's `parentThreadId`; a runId owned by another parent returns
null instead of falling through. Live label resolution dedupes by `runId` so a
run present in both the store and persistence is counted once.

## Verification

- `pnpm test src/agents/runtime.test.ts src/session/session.test.ts` — 23 pass.
- `pnpm lint` — clean.
- `pnpm build` — clean.
- Full `pnpm test` — 131 files, 1506 pass, 1 skipped.

## Deviations and concerns

1. **Runtime signatures add `parentThreadId`.** The phase text abbreviated the
   signatures as `steer(runId, text)`, but the ownership rule (red-team X1:
   "every runtime method re-checks the parent thread") is impossible without the
   caller's thread. The port keeps the phase's public shape and supplies it.
2. **`AgentSpawnPort` control methods are optional.** The two test mocks in
   `src/agents/agent-e2e.test.ts` and `src/tools/builtin/agents.test.ts` only
   implement `spawn`. Making the methods required would force edits to
   `agents.test.ts`, owned by Phase 3, so they are marked optional. The session
   port and runtime implement all four; Phase 3 may promote them to required and
   update its mock at the same time.
3. **Persisted `stopReason` is dropped on reload by cross-phase code.**
   `src/chat/persistence.ts` `validateAgentMeta` does not parse `stopReason`
   (owned by Phase 6). Within a live session the in-memory record keeps it;
   after a reload a stopped child reads `status: 'stopped'` with no reason.
4. **Persisted tool turns.** `transcript()` embeds tool calls as assistant text,
   so a persisted run's `includeTools` adds nothing today; `turnsFromMessages`
   already projects structured tool parts if the transcript shape gains them.

## Next steps

Phase 3 can rely on the port methods; it should guard the optional control
methods and promote them to required if its own mock is updated.
