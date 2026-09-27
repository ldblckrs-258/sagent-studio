---
phase: 1
title: Run message pipeline
status: done
---

# Phase 1 — Run message pipeline

## Goal

A run produces real `UIMessage[]` through the same AI SDK pipeline as the main
engine. Store, persistence, `read_agent`, and the UI all read those messages.
No hand-written event-to-message projection is left.

## Files

- Modify: `src/agents/runner.ts`, `src/agents/types.ts`, `src/agents/store.ts`,
  `src/agents/runtime.ts`, `src/session/session.ts` (snapshot mapping only if
  needed)
- Add: `src/agents/run-transcript.ts` (split plus legacy repair)
- Tests: `src/agents/runner.test.ts`, `src/agents/store.test.ts`,
  `src/agents/runtime.test.ts`, `src/agents/agent-e2e.test.ts`, and new
  `src/agents/run-transcript.test.ts`
- Read first: `src/chat/engine.ts:418-520` and `:1100-1140`
  (`toUIMessageStream` / `readUIMessageStream` usage), `src/chat/sanitize.ts`
  (`rehydrateThread`)

## Steps

1. **Reproduction first.** Add failing tests that encode the user's symptom:
   - A run whose `list_dir` result arrives, then the page "reloads" (the record
     is dropped and the panel reads the persisted child thread). The view must
     show "2 entries", not "0 entries".
   - A run interrupted mid-tool must persist that call as non-terminal, not as
     `output-available` with `{}`.
   - A denied call must persist as denied.
   - A tool error must persist as an error.

   Record which of these fail on the current code before changing anything.
2. **Runner.** Replace the `fullStream` loop:
   - Per pass, pipe `result.stream` into `toUIMessageStream({ stream, tools:
     toolSet, generateMessageId })`, then `readUIMessageStream`.
   - Track text, `toolCalls`, `usage`, abort, and error from the same parts
     (the `finish` metadata or a tee), so `AgentRunResult` is unchanged.
   - Change the callback to `onMessages(messages: UIMessage[])`, emitted on
     every partial.
   - Model history (`history`, `injected`, `result.response`) keeps its
     current logic.
3. **Steer split.** In `run-transcript.ts`, `buildRunMessages({ runId,
   prompt, passes })`:
   - Each pass is `{ assistant: UIMessage | null, steersAt: Array<{ partIndex,
     text }> }`.
   - Produce `[user prompt, assistant(parts[0:k]), user(steer), assistant(parts[k:]),
     …, user(end-of-pass steer), next pass…]`.
   - Ids are stable, `${runId}-a${pass}-${segment}` / `${runId}-s${n}`.
   - `prepareStep` records the steer with the current parts length.
4. **Types and store.**
   - `AgentRunRecord.events` becomes `messages: UIMessage[]`. Keep `text` and
     `toolCalls` as derived counters.
   - Replace `appendEvent` with `setMessages(runId, messages)`, which also
     recomputes `toolCalls` from the tool parts.
   - Delete the `AgentRunEvent` union. The approval queue keeps its own
     records.
5. **Runtime.**
   - `snapshotOf(...).messages = record.messages`.
   - Delete `transcript()` and `turnsFromRecord`. `read_agent` uses
     `turnsFromMessages` for both live and persisted runs.
   - Keep the throttled save (400 ms) and the awaited final save.
6. **Legacy repair.** Move `normalizeThreadMessages` into `run-transcript.ts`
   as `repairLegacyRunMessages`:
   - Coalesce per-delta text parts.
   - Rewrite a tool part that is `output-available` with output `{}` or
     `undefined` into `output-error` with "The result of this call was not
     recorded." Apply this only to child agent threads.
7. Update existing tests that asserted on `events`. Each should assert the real
   output value, never `{}`.

## Validation

- `pnpm exec vitest run src/agents src/chat` passes, and the reproduction tests
  from step 1 now pass.
- `rg "AgentRunEvent|uiMessagesFromEvents|transcript\(" src` returns only
  deletions still pending for phase 6.
- `pnpm exec tsc -b` and `pnpm lint` are clean.

## Risks and rollback

- If `toUIMessageStream` needs `originalMessages` to continue a message across
  passes, emit one assistant message per pass instead. The split logic already
  handles several.
- Rollback: revert this phase's commit. The UI still reads the old event log
  until phase 2 lands.
