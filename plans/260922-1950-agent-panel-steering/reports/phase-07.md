# Phase 7 report: docs and end-to-end verification

Status: completed with one cross-phase concern (see below).

## What landed

- `src/tools/builtin/guides/agents.md` — the "Stopping and reading a child" section now
  names the `read_agent` `lastN` option (6 by default, clamped to 1..50), keeps the
  `includeTools` note, states that both tools are scoped to the conversation that started
  the run, and keeps the untrusted-output caveat.
- `README.md` — the sub-agent section now covers steering and force-stop, the `stopped`
  status (`user_stop`), `stop_agent`/`read_agent`, the inline-at-arrival notice, and adds
  `stop_agent`/`read_agent` to the never-usable list. A closing sentence links the
  operations guide (`src/tools/builtin/guides/agents.md`) instead of duplicating schemas.
- `src/agents/agent-e2e.test.ts` — the harness now wires a real `AgentRunPersistence` over
  the in-memory `ThreadStore`, so a background run persists a genuine child thread with
  `agent` metadata, and `onSettle` builds the same notice shape the session uses
  (`{ status, response, label?, stopReason? }`). Rewrote the failing "exactly one notice"
  test to the Phase 6 behavior: a notice that lands while the parent turn is streaming is an
  inline `data-agent-notice` part on that message (no standalone notice), and it survives
  the remaining chunks and the final write in place. Added three deterministic tests:
  standby idle notice, a spawn → steer → stop → read scenario, and the standalone idle
  case.

## End-to-end scenario (no real timers)

`steers, stops, and reads a background run` injects a mock sub model whose first call holds
its stream on a gate; the test steers while it is held, releases the first turn, and the
runner's continuation pass produces a second model call (`childCalls === 2`). The second
stream is a pending stream that errors on abort, so `runtime.stop` settles the run as
`stopped` / `user_stop`. Assertions cover the live record, the persisted child thread's
`agent.status`/`agent.stopReason`, the parent notice's `status`/`stopReason`, the default
`read` projection containing the steering turn, `read(..., { lastN: 2 })` returning exactly
two oldest-first turns ending on the steering turn, and parent-scope rejection for
`read`/`resolveRun` from another thread. `renders a background notice inline when it arrives
mid-turn` holds the parent's second stream on a gate so the child settles mid-turn, then
asserts the inline part is absent as a standalone message and persists across the final
write.

## Verification

- `pnpm test src/agents/agent-e2e.test.ts` — 6 pass.
- `pnpm test` — 133 files, 1545 passed, 1 skipped.
- `pnpm lint` — clean.
- `pnpm build` — clean.

`src/tools/builtin/tool-guide.test.ts` needed no edit: it asserts guide length and
`covers ⊆ provider names`, both still true.

## Concern: steering is recorded twice (cross-phase, not owned here)

`runtime.steer` → `AgentRunStore.steer` records a `user-message` event
(`src/agents/store.ts:129`), and the runner then records the same message again when it
drains the steering queue at the continuation boundary
(`src/agents/runner.ts:285` → `onEvent` → `src/agents/runtime.ts:396` `appendEvent`). One
steer therefore produces two `user-message` events.

Impact: `read_agent`/`transcript()` returns two identical steering turns (`turnsFromRecord`),
`flowItemsFromRecord` in `src/ui/panels/agent-flow-view.tsx:89` renders two steering
bubbles, and the persisted child thread carries the steering turn twice. `store.steer`'s
immediate record is also what Phase 5's composer reconciles against, so the two writers
are not obviously redundant.

Cause is outside this phase's file ownership (`store.ts`, `runner.ts`, `runtime.ts`), so it
is reported rather than fixed. Phase 1 specified both writers (`phase-01` step 3: the runner
emits a `user-message` per drained message; step 4: `store.steer` appends one before
enqueuing), so this is an upstream design overlap rather than an implementation slip. The
Phase 7 e2e proves the required behavior without codifying the duplicate: it asserts the
steering turn is present in `read` and that `lastN` bounds the projection, not that it
appears exactly once.

## Deviations

- None to the specified interface. The e2e drives `stop_agent`/`read_agent` through the
  runtime control surface rather than the model-tool layer; the tool layer is covered by
  `src/tools/builtin/agents.test.ts` (Phase 3).

## Next steps

- Fix the double steering record (single writer) and add an exact-count assertion to the
  control e2e.
- Hand off to `/ak:ship`.
