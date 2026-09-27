---
phase: 6
title: "Sub-agent notice appears inline at arrival"
status: completed
priority: P1
effort: 0.75d
dependencies: []
---

# Phase 6: Sub-agent notice appears inline at arrival

## Goal

Fix the bug where a background sub-agent's report is always shown at the end of
the parent turn instead of inline, at the moment the main thread receives it.

## Overview

A background run settles while the parent turn may still be streaming. Today the
notice is queued and flushed only when the parent run ends, and it is rendered as
a standalone message, so it always lands at the bottom of the turn. Make the
notice render inline inside the in-flight assistant message at the position it
arrived, and make the streaming loop preserve it instead of overwriting it.

## Root Cause (proven)

- `appendAgentNotice` (`src/chat/engine.ts:665-681`) pushes to `noticeQueue`
  whenever `this.inFlight > 0`; `flushNotices` (`:721-728`) runs only in the run
  and compaction `finally` blocks (`:654`, `:909`). So a notice cannot surface
  until the whole turn ends.
- The queue exists because `executeRun` rebuilds the message array every chunk
  from a snapshot captured at run start (`siblings`, `:986`) and writes
  `[...siblings, partial]` (`:1015`) and `[...siblings, finished]` (`:1032`). Any
  notice appended mid-run is dropped by the next chunk, so deferral was the only
  safe option.
- `src/chat/engine.test.ts:1633-1661` encodes this behavior as expected
  ("queues a notice during a run and flushes it once the run settles").

## Decisions

- The report appears **inline** in the streaming turn, not as a separate message
  appended at the end.
- Representation: a `data-agent-notice` UI part on the assistant message.
- When the parent is idle, the notice is still written immediately, as a
  standalone notice message (today's shape) so nothing regresses there.

## Requirements

- Add `data-agent-notice` to the message part vocabulary with payload
  `{ text: string } & AgentNoticeMeta`.
- `appendAgentNotice` writes immediately; it no longer defers via `inFlight` or
  `noticeQueue`.
  - If a run is in flight for the thread: append the part to the in-flight
    assistant message at the current tail of its parts.
  - If idle: append a standalone notice message carrying the same part (keep the
    `agentNotice` metadata marker for backward compatibility with persisted
    threads).
- The streaming loop updates the assistant message **in place by id**, merging
  the current store message's parts with the reconstructed streaming parts, so an
  injected notice part survives every subsequent chunk, the final `finished`
  write, and persistence.
- Rendering: `AssistantMessage` `MessagePrimitive.Parts` gains a data renderer
  for `agent-notice` that renders `SubAgentReport`; a standalone notice message
  is still detected and rendered as `SubAgentReport` without the assistant bubble
  or Regenerate action.
- `sanitizePartial`, `rehydrateThread`, and `convertPart` leave the data part
  untouched (they only rewrite tool parts), so reload keeps the notice.
- Remove or repurpose `inFlight`/`noticeQueue`/`flushNotices`; verify no other
  caller depends on them.

## Files to Create / Modify

- Modify: `src/chat/engine.ts` (immediate write, in-place stream update, merge)
- Modify: `src/chat/engine.test.ts` (replace the deferred-notice test)
- Modify: `src/chat/types.ts` (notice part type)
- Modify: `src/chat/convert.ts` if the data part needs an explicit mapping
- Modify: `src/components/assistant-ui/elements/thread.aui.tsx` (inline data
  renderer + standalone detection)
- Modify: `src/components/assistant-ui/elements/sub-agent-report.aui.tsx`
  (accept the part payload; markdown is Phase 4)
- Modify: `src/components/assistant-ui/elements/thread.test.tsx` if present

## Implementation Steps

1. Define the `data-agent-notice` part shape and a small guard
   (`isAgentNoticePart`) in `src/chat/types.ts`.
2. In `executeRun`, replace the `siblings` rebuild with an in-place update:
   read the current thread, map over `messages`, replace the message whose id is
   `assistantId` with the streamed partial (preserving its non-streamed injected
   parts), and leave every other message in place. Do the same for the final
   `finished` write.
3. In `appendAgentNotice`, write immediately:
   - in-flight: find the thread's streaming assistant message and append the
     notice part to its parts;
   - idle: append a standalone notice message.
   Persist after each write, tolerating a vault lock as today.
4. Remove `noticeQueue`, `flushNotices`, and the `inFlight` guard if nothing else
   uses them; otherwise narrow `inFlight` to its remaining purpose.
5. In `thread.aui.tsx`, add the `data` renderer for `agent-notice` inside
   `AssistantMessage` parts and keep the standalone-message branch (detect the
   notice part or the legacy `agentNotice` metadata).
6. Tests: rewrite the deferred test to assert the notice is visible **while the
   run is still streaming** (before cancel), and that it survives further chunks
   and a reload. Add a test that an idle notice still appends a standalone
   message.

## Verification

- `pnpm test src/chat/engine.test.ts src/chat/convert.test.ts src/chat/persistence.test.ts`
- `pnpm lint && pnpm build`

## Success Criteria

- A notice reaching a thread mid-turn is visible immediately, inline in the
  in-flight turn, without waiting for the run to settle.
- Subsequent stream chunks and the final write do not remove it.
- A reload still shows the notice; an idle notice is unchanged.
- No orphan `inFlight`/`noticeQueue` code remains.

## Risk Assessment

- **Concurrent writes:** an idle notice and a run persist can interleave; keep
  each write reading the current store synchronously and persisting its own
  snapshot, and add a reload assertion.
- **Part merge correctness:** never re-add a notice part twice; dedupe by a
  notice id.
- **Resume/approval paths:** a resumed run reuses the same assistant id, so the
  in-place update must not disturb an existing paused tool part.

## Security Considerations

- Notice text is untrusted model output; `SubAgentReport` already labels it
  untrusted. No new egress.
- Data parts carry only the report text already stored today.

## Next Steps

- Phase 7 documents the final behavior and runs the full gates.
