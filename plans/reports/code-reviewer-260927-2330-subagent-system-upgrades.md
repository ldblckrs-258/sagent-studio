---
type: code-review
date: 2026-09-27
plan: ../260927-2137-subagent-system-upgrades/plan.md
score: 6/10
status: fixes-pending
---

# Code review: sub-agent system upgrades

The review looked at the uncommitted diff against HEAD. Gates were clean at review time: `tsc -b`, `pnpm lint`, and 1675 tests passing with 1 skipped. Public contracts are preserved: every new field is additive and old persisted data still loads.

## Critical

- **C1. Lost final text.** In `src/agents/runner.ts`, the history rebuild uses `messages.slice(stepResponses)`. In AI SDK 7, `result.response` holds only the final step's messages, so this slice drops the final step's messages.
  - **Effect:** in a multi-step run, the structured-extraction prompt is missing the child's final report, and the next pass after a steer is also missing it.
  - **Fix:** `history = [...stepMessages, ...messages]`.
- **C2. Race in `continue`.** In `src/agents/runtime.ts`, `continue` checks the limits and `controllers.has` before three awaits, and registers the run only after them.
  - **Effect:** parallel continues bypass the limits. Two continues of the same run orphan one stream, and nothing can stop that stream.
  - **Fix:** reserve the run id synchronously before the first await.

## Warnings

- **W1.** A run gathered by `wait_agents` loses its result when the parent turn is aborted. Its notice was suppressed and the tool result is discarded.
- **W2.** Journal eviction (500 entries or 8 MB) silently corrupts `changesForRun` and `planRunRevert`.
  - **Fix:** record the journal head at run start and flag the plan as expired once that point has been evicted.
- **W3.** Child compaction relies only on the input-token count the provider reports. The openai-compatible provider built without `includeUsage` does not report it, so compaction never fires.
  - **Fix:** use `max(measured, estimate(next))`.
- **W4.** When enabled, auto-continue expires a pending parent approval, because a paused thread has no controller and looks idle.
  - **Fix:** skip auto-continue while an approval is pending.
- **W5.** `wait_agents` with `mode: "any"` blocks even when one of its targets has already settled.
- **W6.** Test gaps:
  - multi-step extraction;
  - parallel continue;
  - the context meter UI;
  - the profile chip UI.

## Suggestions

- **S1.** The structured validator lets unsupported keywords pass silently. Use `Object.hasOwn` instead of `in`.
- **S2.** A failed extraction does not add its usage. A stop during extraction reports status `completed`.
- **S3.** The structured value has no size cap in notices or tool results.
- **S4.** Profiles:
  - workspace ids are not clamped in the tool description;
  - `inherit-instructions` in a repo file exposes the user's parent instruction;
  - a profile deleted between spawn and continue fails silently.
- **S5.** `RunChanges` keeps its list and button enabled after a revert, so a second click reports every file as a conflict.
- **S6.** `applyRunRevert` duplicates the in-flight `applyRestore` from the message-rewind plan. A throw partway through loses the partial outcome.
- **S7.** `message_agent` bypasses a persisted `deny` on `spawn_agent`.
- **S8.** A continue started from the UI uses the tool pool recorded at spawn time.
- **S9.** A doc comment in `tools/builtin/agents.ts` still says "all three" tools.
- **S10.** A superseded profile registry load returns while holding a stale list.

## Verdicts

- **(a) Acceptance criteria.**
  - Items 1, 4, 5, 7, 8 and 9 are met.
  - Item 2 is partial (W3).
  - Item 3 is not met for multi-step runs (C1).
  - Item 6 is partial (W1, W5).
- **(b) Blast radius.** One regression: C1 changes how history carries over after a steer. Two new defects are on new paths (C2, W1).
- **(c) Contracts.** Preserved.
- **(d) Patterns.** Followed.
- **(e) Lint, types and build.** Clean.

## Side effects

- C1 changes how history carries over after a steer between passes.
- C2 lets `continue` exceed the concurrency limits.
- W4 applies only when auto-continue is enabled; it is off by default.

## Environment note

During the review, another workstream (message rewind) edited these files in the same working tree:
- `src/workspace/journal.ts`
- `src/workspace/journal-io.ts`
- `src/workspace/errors.ts`
- `src/tools/builtin/history.ts`

## Unresolved questions

1. Acceptance criterion 4 says the profile applies a "mode ceiling", but phase 4 says explicit fields override the profile. As built, an explicit `mode` can raise a read-only profile, still capped by the parent's mode.
2. Should `applyRunRevert` be merged onto the message-rewind `applyRestore` once that lands?

## Fix cycles (2026-09-27)

After two fix cycles, the re-review scored the change 8/10, and the final gates pass: 1708 tests (1 skipped), `tsc -b` with 0 errors, and lint clean.

### Fixed, each with a test

- **C1.** `history = [...stepMessages, ...messages]`.
- **C2.** A synchronous `reserved` slot, counted by `limitFor`.
- **W1 and W-1.** An aborted wait now delivers its pending notices synchronously, before any await.
- **W5.** `any` mode returns at once when a target has already settled.
- **W2 and W-3.**
  - The journal tracks `evictedRuns` and persists them.
  - A revert of such a run reports `expired`, and the UI disables revert and says why.
  - `filesChangedIncomplete` appears in results, wait runs, and notices.
- **W3.** The context figure is `max(measured, estimate)`.
- **W4.** Auto-continue skips while a parent approval is pending.
- **W6.** Tests for the context meter and the profile chips.
- **S1.** `Object.hasOwn`, with the enforced keyword subset documented.
- **S2.** A failed extraction's usage is counted, and a stop during extraction has a clear message.
- **S5.** Revert is disabled after an outcome.
- **S9.** The stale comment is fixed.
- **S10.** A superseded profile load waits for the newest one.
- **Tester gaps.** Tests now cover continuing after compaction and an empty `wait_agents`.

### Deferred (follow-ups)

- **W-2.** This behavior already existed at HEAD. A background notice that arrives after a turn has paused on an approval is appended after it, so `respondToApproval` treats the approval as stale and expires it. The auto-continue guard stops auto-continue from making this worse, but it does not fix the expiry.
  - **Options:** anchor the notice inside the paused message, or have `respondToApproval` ignore notice-only messages that follow it.
- **`RunChanges` outcome.** The outcome is not reset when the same view continues the run; a remount clears it.
- **Heavy estimate.** `estimateModelMessagesTokens` stringifies the history on every step and can overestimate, so compaction may start early.
- **`mode: any` duplicate.** A target caught mid-settle with `mode: 'any'` can appear both in the result and as a notice. The window is short.
- **Capacity mismatch.** While a continue holds its reservation, `activeCount` and `activeForThread` do not count it.
- **Merge follow-up.** Merge `applyRunRevert` onto the message-rewind `applyRestore` once that lands (user decision).
- **Pre-existing.** `stop_agent` and `read_agent` are in no mode ceiling, so they prompt for approval in `read_only` and `editing`.
- **Environment.** The RTK hook's global TypeScript 5.x reports 42 false errors. The project's `pnpm exec tsc -b` (TS 6) is clean.
