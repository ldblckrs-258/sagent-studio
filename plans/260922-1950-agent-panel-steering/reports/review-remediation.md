# Review remediation report

Status: completed. One intentional mechanism deviation (M2), no contract breaks.

Scope: 1 High + 4 Medium findings from the working-tree review. Each fix has a
regression test that was run against the reverted production change and observed
to fail, then restored.

## H1 — inline sub-agent notice dropped from model input

- `src/chat/types.ts`: added `convertAgentNoticePart(part)` returning
  `{ type: 'text', text: part.data.text }` for an inline `data-agent-notice`
  part, `undefined` otherwise. Tolerant of malformed payloads (non-string
  `data.text` is ignored).
- `src/chat/engine.ts` (`buildRunStream`): passed `convertDataPart:
  convertAgentNoticePart` to `convertToModelMessages`.
- `src/chat/compact.ts` (`summarizeMessages`): same option, so a summary over a
  notice-bearing window also reads the notice.

Signature check: `node_modules/ai/dist/index.d.ts:5739` types the option as
`(part: DataUIPart<InferUIMessageData<UI_MESSAGE>>) => TextPart | FilePart |
undefined`. The converter accepts a wider `UIMessage["parts"][number]`, which is
assignable, and the build typechecks without casts.

Tests (`src/chat/engine.test.ts`): a direct mapping test (notice → text, other
data part and malformed payload → undefined) and an engine integration test that
seeds a prior assistant message carrying a notice and asserts the marker text
appears in the next turn's model prompt. Removing the `convertDataPart` option
makes the integration test fail with the marker absent from the prompt.

## M1 — `read_agent` diverged live vs reloaded

- `src/agents/runtime.ts` (`transcript`): emits a real
  `{ type: 'dynamic-tool', toolName, toolCallId, state: 'output-available',
  input: {} }` part per `tool-call` event instead of the `[called X]` text marker.
  This is the shape `turnsFromMessages` and `flowItemsFromThread` already
  recognize. Verified by reading that `sanitizePart` treats `output-available` as
  terminal (so `sanitizePartial`/`rehydrateThread` preserve it) and
  `persistence.ts` stores message parts opaquely.

Test (`src/agents/runtime.test.ts`): spawns a background run whose model emits a
tool call then text, waits for settle, removes the live record to force the
persisted path, then asserts `includeTools: true` yields the `role: 'tool'` turn
and the default projection drops it with no `[called` text in assistant turns.
Reverting to the marker makes the `includeTools: true` assertion fail.

## M2 — a steer could be accepted but never delivered

- `src/agents/types.ts`: `AgentSteeringHandle` gained optional `accepting?()` and
  `close?()`.
- `src/agents/runtime.ts` (`createSteeringControl`): implements both over a
  `closed` flag.
- `src/agents/store.ts` (`steer`): returns false when `handle.accepting` exists
  and reports closed.
- `src/agents/runner.ts`: calls `steering?.close?.()` after the streaming loop,
  covering the normal and caught paths.
- `src/ui/panels/agent-flow-view.tsx`: a settled run no longer shows an
  unreconciled echo.

Mechanism deviation: the finding suggested clearing optimistic echoes in an
effect. `react-hooks/set-state-in-effect` (React Compiler lint) rejects a
synchronous `setState` in an effect and `pnpm lint` is a hard gate, so the
component derives `activeOptimistic = status === "running" ? optimistic : []`
instead. Behavior is identical — the echo disappears the moment the run leaves
`running` — with no second render on settle.

Tests: `store.test.ts` asserts `steer` returns false after `close` and only
enqueued once; `runner.test.ts` asserts the injected control's `close` spy is
called exactly once on settle; `agent-flow-view.test.tsx` accepts an optimistic
steer, then settles the record and asserts the echo text is gone. Each fails
against the reverted change.

## M3 — `prepareStep`-injected steering missing from later history

- `src/agents/runner.ts`: `prepareStep` now accumulates each drained steer into an
  `injected: ModelMessage[]` and the pass resolves with
  `history.push(...injected, ...messages); injected.length = 0`. The array passed
  to `streamText` is never mutated mid-pass.

Verified in the installed SDK (`node_modules/ai/dist/index.js:10117`) that a
step's `response.messages` holds only generated messages, and
`result.response` resolves the final step, so the injected user turns are not
already present.

Test (`src/agents/runner.test.ts`): a first pass injects `first steer` through
its `prepareStep`, a `second steer` queued too late forces a second pass, and the
third model call's prompt must contain `first steer`. Reverting the accumulation
loses it and the test fails.

## M4 — `read_agent` had no aggregate output bound

- `src/tools/builtin/agents.ts`: added exported `MAX_AGENT_READ_CHARS = 32000`.
  `boundTurns` now caps each turn at `MAX_TURN_CHARS` and the whole result at the
  aggregate, trimming the turn that crosses the boundary and setting
  `truncated: true`.

Tests (`src/tools/builtin/agents.test.ts`): ten 8000-char turns stop at the cap;
ten 5000-char turns trim the seventh to 2000; both keep the existing per-turn
truncation test green. Reverting `boundTurns` to the per-turn-only version fails
the aggregate test.

## Existing assertions

None weakened or removed. No public contracts removed; all additions are additive
(`convertAgentNoticePart`, `MAX_AGENT_READ_CHARS`, optional handle methods).
No new dependencies.

## Verification

- `pnpm test`: 133 files, 1555 passed, 1 skipped.
- `pnpm lint`: clean.
- `pnpm build`: `tsc -b && vite build` succeeds.

## Notes / residual concerns

- M2 closes the channel only after the streaming loop, matching the finding. An
  early `runAgent` return (`invalid_input`, no model) settles immediately and the
  runtime detaches steering, so no echo can survive there; `close` simply never
  runs on those paths.
- M3 pushes the injected turns before a pass's generated messages per the
  finding. Within a multi-step pass the injected turns can therefore precede that
  pass's earlier tool messages in `history`; the SDK accepts the order and no test
  depends on interleaving.
