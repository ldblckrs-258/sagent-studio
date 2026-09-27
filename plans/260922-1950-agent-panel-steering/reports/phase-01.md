# Phase 1 report: steering and stop runtime

Status: completed.

## What landed

- `AgentRunStatus` gained `stopped`; `AGENT_RUN_STATUSES`, the report tone map,
  and the panel tint map carry it.
- `AgentStopReason = 'user_stop'` on `AgentRunResult`, `AgentThreadMeta`,
  `AgentNoticeReport`, and `AgentRunRecord`.
- `AgentRunEvent` gained `{ type: 'user-message'; text }`.
- `runAgent` runs a continuation loop: `history: ModelMessage[]`, `messages`
  instead of `prompt`, `prepareStep` injection, `result.response.messages`
  accumulation, summed usage, and `stopped` + `stopReason` on a user stop.
- `AgentRunStore` owns a steering map (`attachSteering`, `detachSteering`,
  `steer`, `requestStop`, `stopRequested`); `finish` keeps the runner status and
  reason; `remove`/`clear` drop steering state.

## Contract note for Phase 2

The steering channel is split into two interfaces in `src/agents/types.ts`:

- `AgentSteeringHandle` — the read side the runner consumes (`drain`,
  `stopRequested`, `stopReason`).
- `AgentSteeringControl extends AgentSteeringHandle` — adds `enqueue` and
  `requestStop`. `AgentRunStore.attachSteering` takes this and `steer`/
  `requestStop` delegate to it.

`requestStop(reason)` is the implementation's contract to record the reason and
abort the run's controller; the store holds no controller. Phase 2 should build
one control per run over the run's `AbortController`, attach it in `spawn`, and
pass it as `runnerDeps.steering`. The runner then reports `stopped` when
`stopRequested()` is true at abort time.

## SDK confirmation

`ai@7.0.105` `streamText().response` is a promise of
`LanguageModelResponseMetadata`, which carries `messages: ResponseMessage[]`
(assignable to `ModelMessage[]`), so the plan's `const { messages } = await
result.response` holds. `result.steps` gives the per-pass step count used for
the combined cap.

## Hardening present

- Injection only when the message tail is a `tool` or `assistant` turn;
  otherwise the pending text stays queued for the next outer pass.
- Per-pass `stopWhen` uses the remaining total-step budget, so an outer pass
  cannot double the cap; `MAX_AGENT_STEERS = 20` bounds the number of steers.
- `result.response` and `result.steps` are read inside a try/catch that keeps
  the last good history.

## Verification

`pnpm test src/agents/runner.test.ts src/agents/store.test.ts` (15 pass),
`pnpm lint`, `pnpm build`, and the full `pnpm test` (131 files, 1498 pass,
1 skipped) all green.
