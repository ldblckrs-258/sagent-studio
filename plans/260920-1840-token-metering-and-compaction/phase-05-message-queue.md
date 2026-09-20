---
phase: 5
title: "Phase 5: Message queue"
status: done
priority: P1
effort: "5h"
dependencies: [4]
---

# Phase 5: Message queue

## Goal

Keep the composer usable during a run by queueing messages and dispatching them in order once the run settles, including queued slash commands.

## Context

`@assistant-ui/core@0.3.19` ships the queue. `createMessageQueue(driver)` returns `{ adapter, notifyBusy, notifyIdle, notifyCancelled, clear, subscribe }`; `useExternalStoreRuntime` takes the adapter as `queue`. With `queue` set, the runtime routes every append into the queue, using the steer lane while the thread is running and the queue lane otherwise. `ComposerInput` unlocks Enter during a run once `capabilities.queue` is true, and `ComposerPrimitive.Queue` renders pending items. The driver is the single dispatch path, so the slash routing from Phase 4 moves into it.

## Files to Create / Modify

- Create: `src/chat/queue.ts`
- Create: `src/chat/queue.test.ts`
- Modify: `src/chat/use-chat-runtime.ts`
- Modify: `src/components/assistant-ui/elements/thread.aui.tsx`

## Implementation Steps

1. In `src/chat/queue.ts`, add `createChatQueue({ dispatch, cancel })` wrapping `createMessageQueue`, where `dispatch(message)` extracts the text with the existing `extractText` helper and routes it through the Phase 4 slash path or `engine.sendTurn`.
2. Make the driver's `run` synchronous from the library's point of view: it starts the work and lets a rejection surface through `setError`, since a synchronous throw is treated by the library as a run that never started.
3. In `src/chat/use-chat-runtime.ts`, create the controller once per session with `useMemo`, pass `queue: controller.adapter` to `useExternalStoreRuntime`, and keep `onNew` as the fallback path for the case where the queue is absent.
4. Drive the busy signal from the store: subscribe to the active thread's running count and call `notifyBusy` on the rising edge and `notifyIdle` on the falling edge, so the queue advances exactly when a run settles.
5. Call `controller.notifyCancelled()` inside `onCancel` before `engine.cancel`, so a user cancel holds the pending items instead of draining them.
6. Clear the controller when the active thread changes, so a queued message never lands on a different conversation.
7. In `thread.aui.tsx`, render the pending items with `ComposerPrimitive.Queue` directly under the composer shell, each with a remove action, above the context meter added in Phase 6.

## Verification

- `pnpm exec vitest run src/chat/queue.test.ts`
- `pnpm exec vitest run src/chat/use-chat-runtime.test.ts` if that file exists, otherwise add the coverage to `src/chat/queue.test.ts`
- `pnpm lint`

## Success Criteria

- [x] Sending while a run is in flight adds an item to the queue instead of starting a second run.
- [x] Items dispatch in the order they were added once the run settles.
- [x] A queued slash entry, `/compact` or `/<skill-id>`, runs through the slash path when it reaches the front of the queue.
- [x] Cancelling a run leaves the queue intact, and the next explicit send resumes draining.
- [x] Switching threads clears pending items rather than dispatching them into the new thread.
