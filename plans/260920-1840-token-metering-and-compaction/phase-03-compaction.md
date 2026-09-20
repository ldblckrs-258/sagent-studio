---
phase: 3
title: "Phase 3: Compaction core and auto-compact"
status: done
priority: P1
effort: "6h"
dependencies: [1, 2]
---

# Phase 3: Compaction core and auto-compact

## Goal

Compact a thread by appending a summary boundary, send only the summary plus later messages to the model, and trigger compaction automatically when the context reaches the configured cap.

## Context

`buildRunStream` in `src/chat/engine.ts` converts the whole `messages` array with `convertToModelMessages` before calling `streamText`. `startRun` is the single entry point for every run and already distinguishes a fresh run from an approval resume through `options.resumeAssistantId`. Threads persist through `src/chat/persistence.ts`, which passes messages through untouched, so a boundary message needs no schema change.

## Files to Create / Modify

- Create: `src/chat/compact.ts`
- Create: `src/chat/compact.test.ts`
- Modify: `src/chat/engine.ts`
- Modify: `src/chat/sanitize.ts`
- Modify: `src/chat/engine.test.ts`

## Implementation Steps

1. In `src/chat/sanitize.ts`, extend `ChatMessageMetadata` with `compaction?: { at: number; replacedCount: number; tokensBefore: number; instructions?: string }`.
2. In `src/chat/compact.ts`, add `findBoundaryIndex(messages)` returning the index of the last message whose metadata carries `compaction`, and `messagesSinceBoundary(messages)` returning the boundary message plus everything after it, or the whole array when there is none.
3. Add `summarizeMessages(deps, config, messages, instructions?)` that calls `generateText` with the thread's own provider, model, and params through the existing `modelFactory`, using a summarization system prompt that asks for the decisions, the current task state, open threads, and file paths touched. Pass the run's `AbortSignal`.
4. Add `compactThread(deps, thread, instructions?)` that summarizes `messagesSinceBoundary(thread.messages)`, then appends one assistant message holding the summary text and the `compaction` metadata. On any failure it returns the original thread unchanged and rethrows, so the caller can surface the error without mutating state.
5. In `buildRunStream`, replace the `messages` argument to `convertToModelMessages` with `messagesSinceBoundary(messages)`, leaving the stored array untouched and keeping `originalMessages: messages` for `toUIMessageStream`.
6. In `startRun`, before building the stream and only when `options.resumeAssistantId` is undefined, compute `contextTokensOf(runBase)` and call `compactThread` when `shouldAutoCompact` says so; persist the compacted thread and continue the run from the compacted base.
7. When auto-compaction throws, log the error to the thread's error banner through `setError`, then continue the run with the uncompacted base rather than dropping the user's turn.

## Verification

- `pnpm exec vitest run src/chat/compact.test.ts`
- `pnpm exec vitest run src/chat/engine.test.ts`
- `pnpm lint`

## Success Criteria

- [x] After `compactThread`, the stored thread still contains every original message plus one boundary message.
- [x] `buildRunStream` sends only the boundary message and later messages to the model, verified through a stubbed `modelFactory`.
- [x] A rejected summarization leaves `thread.messages` byte-identical and surfaces the error.
- [x] Auto-compaction fires once at the threshold, and never when `startRun` is called with `resumeAssistantId`.
- [x] A second compaction summarizes only the messages after the previous boundary.
