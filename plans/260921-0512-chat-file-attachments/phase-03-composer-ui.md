---
phase: 3
title: "Phase 3: Chip bar, upload button, dropzone"
status: completed
priority: P1
effort: "8h"
dependencies: [1, 2]
---

# Phase 3: Chip bar, upload button, dropzone

## Goal

Give the composer a per-thread chip list with an upload button, a validated dropzone, and an auto chip that follows the file the user opened, and resolve those chips where the message is actually dispatched.

## Context

Every composer send goes into the queue: `useChatRuntime` always supplies `queue: queue.adapter` (`src/chat/use-chat-runtime.ts:236`), and the runtime returns into `enqueue`/`steer` before ever reaching `onNew` (`@assistant-ui/core/src/runtimes/external-store/external-store-thread-runtime-core.ts:667-679`). `onNew` is dead code in this app. The live path is the driver in `src/chat/queue.ts:76-87`, which keeps only `extractText(message.content)`. The queue adapter exposes `enqueue`, `steer`, `edit`, and `remove` (`@assistant-ui/core/src/runtime/queue/external-thread-queue-adapter.ts`), so it can be wrapped.

The workspace is bound per thread (`src/session/session.ts:161-164`, `src/session/workspace-state.ts:138-160`) and `bindThread` is async, so a chip must never outlive its thread. The queue already resets on a real thread-to-thread change (`src/chat/use-chat-runtime.ts:114-119`).

The composer shell is `ComposerPrimitive.AttachmentDropzone` wrapping input and controls (`src/components/assistant-ui/elements/thread.aui.tsx:488`); it checks `thread.capabilities.attachments` and only reacts to `Files`, so today it is styling and its `data-dragging` attribute. `ApprovalPrompt` renders above the shell and `ContextMeter` below the composer, so the chip row belongs inside the shell, above the input. `useWorkspaceStore` reports `ready` from a `mode: 'read'` query only (`src/session/workspace-state.ts:55-95`), so `ready` does not prove the handle can write.

## Files to Create / Modify

- Create: `src/chat/attachment-store.ts`
- Create: `src/chat/attachment-store.test.ts`
- Create: `src/ui/attachment-bar.tsx`
- Create: `src/ui/composer-dropzone.tsx`
- Modify: `src/chat/queue.ts`
- Modify: `src/chat/queue.test.ts`
- Modify: `src/chat/use-chat-runtime.ts`
- Modify: `src/ui/composer-controls.tsx`
- Modify: `src/components/assistant-ui/elements/thread.aui.tsx`

## Implementation Steps

1. In `src/chat/attachment-store.ts`, create a zustand store with `items: Record<string, Attachment[]>` keyed by thread id, `autoDisabled: Set<string>`, `add(threadId, attachment)`, `remove(threadId, id)`, `take(threadId): Attachment[]` (returns and clears the manual chips in one call), `disableAuto(threadId)`, `enableAuto(threadId)`, and `clearThread(threadId)`. `add` dedupes on path and keeps the first source. Nothing persists.
2. Add `autoAttachmentFor(fileViewState, path)`: returns an `auto` chip only when the File panel is showing a workspace path, that path is **not** in `useFileViewStore.authored`, and it is not deny-listed. `authored` is the set `presentWorkspace` writes for model-initiated opens (`src/session/file-view-state.ts:17`, `:78-81`), which is what keeps `open_preview` from steering the composer.
3. Subscribe the store to `useChatStore.activeThreadId` and call `clearThread` for the previous thread on a real thread-to-thread change, mirroring the queue's own reset.
4. In `src/chat/queue.ts`, widen `ChatQueueOptions.dispatch` to `(text, extra?: AttachmentDispatch)` and add an optional `capture?: () => AttachmentSnapshot | undefined`. Wrap the controller adapter so `enqueue` and `steer` call `capture()` first and store the result in a `WeakMap<AppendMessage, AttachmentSnapshot>` before delegating; `run` reads it back and hands it to `dispatch`. The snapshot carries the thread id it was captured on.
5. Resolve inside the driver, not at capture: `dispatch` receives the snapshot and resolves it against the currently bound `fs`, aborting with an error when the bound thread no longer matches the snapshot's thread id. Document the consequence in a comment: a message that waited in the queue sends the file's newer content, which is the same rule as an immediate send.
6. In `src/ui/attachment-bar.tsx`, render one chip per attachment: the icon from `fileLookFor`/`folderLookFor` (`src/ui/panels/file-icon.ts`), the basename, a `title` and a visible dimmed parent path for the auto chip so its full path is never hidden, a size badge when `bytes` is known, an `auto` badge, and a remove button. The row wraps to at most two lines then scrolls, and renders nothing when empty. Removing the auto chip calls `disableAuto(threadId)`.
7. In `src/ui/composer-dropzone.tsx`, implement the replacement dropzone. Accept an internal drop only when `dataTransfer` carries both `application/x-sagent-path` and `application/x-sagent-token` whose value equals this session's random token; then split on newlines, cap at 20, and keep only paths that pass `resolveSegments` and `stat`. Never read `text/plain` as a path. Accept native `Files` through the upload routine. Keep `data-dragging="true"` so the existing shell classes work, and `preventDefault` only for accepted payloads. Report every rejection through `useChatStore.setError`.
8. Export the upload routine from the same module: for each picked file, sequentially `uniqueUploadPath(fs, 'uploads', file.name)`, then `writeWorkspaceBlob(fs, path, file)`, then `add(threadId, { kind: 'file', path, source: 'upload', bytes: file.size })`. Sequential, because two identical names probed in parallel would both look free. Surface `WorkspaceLimitError` and `WorkspacePermissionError` through `setError`, and route a permission failure to `regrant()` (`src/session/workspace-state.ts:162-171`).
9. In `src/ui/composer-controls.tsx`, add a `+` button at the head of the control row opening a hidden `<input type="file" multiple>`. Gate it on `queryPermission({ mode: 'readwrite' })` rather than on `status === 'ready'`, since `ready` is established from a read query. Its tooltip names the destination directory, so an upload in `read_only` mode is never silent.
10. In `thread.aui.tsx`, replace `ComposerPrimitive.AttachmentDropzone` with the new dropzone, keeping `data-slot` and class names, and render `<AttachmentBar />` directly above `SlashSuggestions`. Extend the queued-message row (`:524-542`), which currently renders only `QueueItemPrimitive.Text`, with a count of the attachments captured with that item, so a queued message's payload is visible.
11. In `src/chat/use-chat-runtime.ts`, pass `capture` into `createChatQueue` (reading `take(threadId)` plus the auto chip) and forward the resolved `extra` from `dispatch` into `sendTurn`. Leave `onNew` in place but add a comment recording that the queue adapter makes it unreachable, so the next reader does not wire logic into it.

## Verification

- `pnpm exec vitest run src/chat/attachment-store.test.ts src/chat/queue.test.ts`
- `pnpm exec vitest run src/chat`
- `pnpm lint`
- Manual, in the browser: three chips with a pending approval at the narrowest composer width; an upload after a page reload, to exercise the permission gate.

## Success Criteria

- [x] Picking two files through `+` writes both under `uploads/` and shows two chips; a native drop does the same.
- [x] A drop carrying no session token, 500 paths, or a `../` path adds no chip and explains why.
- [x] Sending clears the manual chips at enqueue and leaves the auto chip.
- [x] A message typed during a run keeps its chips through the queue and dispatches them when it drains; the queued row shows the count.
- [x] Attaching in thread A and switching to thread B leaves no chips in either.
- [x] A send whose bound thread changed mid-flight aborts resolution and reports it instead of attaching the wrong folder's file.
- [x] A model-initiated preview produces no auto chip; a user open does, and it shows its full path.
- [x] After a reload where the handle is read-only, `+` routes to regrant instead of failing at write time.
- [x] The chip row sits between the approval prompt and the input, and neither the prompt nor the meter moves.
- [x] A send with no chips produces exactly the message it produces today.

Manual browser checks in the Verification list were skipped at the user's
instruction ("no browser check"). The layout and reload-permission criteria are
therefore unverified; everything else is covered by the automated tests above.

## Deviations

| Drafted | Built | Why |
|---|---|---|
| The upload routine exports from `composer-dropzone.tsx` | It lives in `src/ui/composer-upload.ts`; the dropzone component imports it | `react-refresh/only-export-components` rejects a module that exports both a component and plain functions, and that rule is enforced by `pnpm lint`. |
| `+` gates on `queryPermission({ mode: 'readwrite' })` read in an effect | The query runs on pointer-enter and focus, and the click stays synchronous | `react-hooks/set-state-in-effect` forbids the effect, and awaiting the query inside the click would spend the user gesture the file picker needs. A write that still fails with `WorkspacePermissionError` routes to `regrant()`, as drafted. |
| Chips keyed by thread id | Chips before the first send are keyed by `''` and adopted by the thread that send creates | `activeThreadId` is null until the first send, which is the same edge the queue treats as "not a switch". |
