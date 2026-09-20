---
phase: 1
title: "Phase 1: Usage capture and token accounting"
status: done
priority: P1
effort: "4h"
dependencies: []
---

# Phase 1: Usage capture and token accounting

## Goal

Record provider token usage and stream timing on every assistant message, and derive thread totals and current context size from the stored messages.

## Context

`src/chat/engine.ts` builds the run with `streamText` and converts it with `toUIMessageStream`. That helper accepts `messageMetadata`, which stamps metadata onto the streamed UI message; the finish part carries `totalUsage`. Message metadata already persists with the thread, so usage needs no new persisted field. `src/chat/sanitize.ts` owns the `ChatMessageMetadata` type and `setChatStatus`, which merges rather than replaces metadata.

## Files to Create / Modify

- Create: `src/chat/usage.ts`
- Create: `src/chat/usage.test.ts`
- Modify: `src/chat/sanitize.ts`
- Modify: `src/chat/engine.ts`
- Modify: `src/chat/store.ts`
- Modify: `src/chat/engine.test.ts`

## Implementation Steps

1. In `src/chat/usage.ts`, define `TurnUsage` with `inputTokens`, `outputTokens`, `totalTokens`, `durationMs`, `tokensPerSecond`, and `estimated: boolean`.
2. Add `estimateTokens(text: string): number` using a documented characters-per-token divisor of 4, and `estimateMessagesTokens(messages)` that serializes text and tool parts the same way the request does.
3. Add `usageOf(message): TurnUsage | undefined` reading `metadata.usage`, `totalTokensOf(messages)` summing every recorded turn, and `contextTokensOf(messages)` returning the last assistant turn's `inputTokens + outputTokens` when present and the estimate otherwise, with `estimated` set accordingly.
4. In `src/chat/sanitize.ts`, extend `ChatMessageMetadata` with `usage?: TurnUsage`, keeping the existing `chatStatus` and `error` fields untouched.
5. In `src/chat/engine.ts`, pass `messageMetadata: ({ part }) => ...` to `toUIMessageStream`. The callback fires on `start` and `finish` only; on `part.type === "finish"` read `part.totalUsage` (`inputTokens`, `outputTokens`, `totalTokens`, each optional) and return `{ usage }` with the measured duration and the derived rate, returning `undefined` on `start` so nothing is overwritten. Record the stream start when the first chunk arrives and the end when the loop exits.
6. In `src/chat/store.ts`, add a transient `liveStats: Record<string, { startedAt: number; chars: number }>` with `setLiveStats(threadId, stats)` and `clearLiveStats(threadId)`; clear it in `endRun` and in `clear()`. Do not persist it.
7. In the `readUIMessageStream` loop in `executeRun`, accumulate the streamed text length and publish it through `setLiveStats`, so the UI can derive a live rate without another subscription.

## Verification

- `pnpm exec vitest run src/chat/usage.test.ts`
- `pnpm exec vitest run src/chat/engine.test.ts`
- `pnpm lint`

## Success Criteria

- [x] `contextTokensOf` prefers real usage and falls back to an estimate flagged `estimated: true`.
- [x] A completed run leaves `metadata.usage` on the assistant message alongside `chatStatus: "done"`, proving the metadata merge does not clobber either field.
- [x] `liveStats` is cleared when a run ends, is absent from persisted threads, and never appears in `saveThread` payloads.
- [x] Existing engine tests still pass unchanged.
