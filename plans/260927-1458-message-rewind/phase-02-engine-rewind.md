---
phase: 2
title: "Engine rewind"
status: completed
priority: P1
effort: "3.5h"
dependencies: [1]
---

# Phase 2: Engine rewind

## Goal

Each sent user message carries a journal marker, and `ChatEngine` can preview and perform a rewind to before that message: restore files (when safe), cut the thread, and hand back the message text. A busy thread is refused.

## Context

- `src/chat/engine.ts` — `sendTurn` builds the user message (~L550-573); `editMessage`, `rerun`, and `undo` are the existing thread-rewriting operations; `setThreadMessages` + `persist` is the write path; `deps.journalFor(threadId)` loads the thread journal; `deps.workspace` is the live folder.
- `src/chat/reducer.ts` — `editMessage` keeps metadata (drops only `attachments`), so a marker survives an edit and a later rewind undoes every branch since the message was first sent.
- `src/chat/store.ts` — `runningThreads[threadId]` and `compactingThreads[threadId]` are the busy signals for the parent run and compaction.
- `src/agents/runtime.ts` — `activeForThread(threadId)` counts live sub-agents of a thread; the engine has no access to it today.
- `src/session/session.ts:450-470` — engine deps are built after `agentRuntime`, so a new dep can close over it.
- `src/session/session.ts:275-280` + `workspace-state.ts` — `thread.workspaceName` is synced from the live folder of the active thread; the live folder follows `activeThreadId`.

## Files to Modify

- Modify: `src/chat/sanitize.ts` (`ChatMessageMetadata.rewind?: { seq: number; workspace?: string }`)
- Modify: `src/chat/reducer.ts` (`truncateBefore(messages, id)`)
- Modify: `src/chat/errors.ts` (`ChatRewindBusyError`)
- Modify: `src/chat/engine.ts`
- Modify: `src/session/session.ts` (wire `activeAgentsFor`)
- Modify: `src/chat/engine.test.ts`, `src/chat/reducer.test.ts`

## Tasks & Steps

1. **Marker type** — add `rewind?: { seq: number; workspace?: string }` to `ChatMessageMetadata`.
2. **Stamp on send** — in `sendTurn`, when `deps.journalFor` exists, load the journal and set `metadata.rewind = { seq: journal.head(), workspace: thread.workspaceName }` (omit `workspace` when undefined), merged with any `attachments` metadata. No other path stamps (edit keeps the original marker, rerun reuses the message).
3. **Reducer** — `truncateBefore(messages, id)` returns `messages.slice(0, index)`, or the input unchanged when the id is absent.
4. **Busy dep** — add `activeAgentsFor?(threadId: string): number` to `PipelineDeps`; in `session.ts` wire it to `agentRuntime.activeForThread`.
5. **Busy check** — private `isBusy(threadId)`: parent run count > 0, compaction in flight, or `activeAgentsFor(threadId) > 0`.
6. **Shared preparation** — private `prepareRewind(threadId, messageId)` resolves:
   - the target (must be a `user` message; otherwise throw `ChatError`),
   - `removedMessages` (count from the target to the end),
   - `text` (the message's text parts, excluding attachment text via `isAttachmentPartText` from `attachments.ts`),
   - `files` status: `no-marker` | `no-workspace` (no `deps.workspace`, or the thread is not the active thread) | `folder-mismatch` (`marker.workspace` missing or not equal to `thread.workspaceName`) | `expired` | `ok`,
   - when `ok`, the `planRestoreAt(marker.seq)` result.
7. **`previewRewind(threadId, messageId)`** — public on `ChatEngine`. Returns `{ removedMessages, text, files, restore: string[], remove: string[], unrestorable: string[], conflicts: string[], busy }`. Conflicts are computed read-only by comparing current content with `expected` (reuse `readForJournal`; do not write).
8. **`rewind(threadId, messageId)`** — public on `ChatEngine`:
   - Throw `ChatRewindBusyError` when `isBusy`.
   - When `files === 'ok'`: `applyRestore(journal, workspace, plan.changes, { checkConflicts: true })`. On `RestoreApplyError`, return the partial outcome with `failed` set and leave the thread untouched.
   - Otherwise, or after a successful apply: `setThreadMessages(truncateBefore(...))`, then `persist`.
   - Return `{ text, files, restored, removed, skipped, conflicts, unrestorable, failed? }`.
9. **Tests** (`engine.test.ts`; extend `setup` with `journalFor` and a fake workspace from `createFakeWorkspace` + `createWorkspaceFs`):
    - `sendTurn` stamps `rewind.seq` equal to the journal head at send time, and `editMessage` preserves it.
    - Rewind to message N: only messages before N remain and are persisted; a file edited after N is restored; a file created after N is removed; the returned `text` is N's text.
    - Busy refusal: with `beginRun`, with `beginCompaction`, and with `activeAgentsFor` returning 1, `rewind` throws `ChatRewindBusyError` and neither files nor messages change.
    - Conflict: a file rewritten directly on the workspace after the agent's journaled edit is returned in `conflicts`, keeps its content, and the thread is still cut.
    - Folder mismatch: marker workspace differs from `thread.workspaceName` → `files: 'folder-mismatch'`, no file change, thread cut.
    - No marker (legacy message) → `files: 'no-marker'`, thread cut, no file change. This is a supported path, not only a defensive one: the UI offers conversation-only rewind for such messages.
<!-- Updated: Validation Session 1 - legacy messages get conversation-only rewind; rewindable flag dropped -->
    - Apply failure (workspace write rejected) → `failed` set, thread unchanged.
10. **Tests** (`reducer.test.ts`): `truncateBefore` cases.

## Verification

- `pnpm vitest run src/chat/engine.test.ts src/chat/reducer.test.ts`
- `pnpm lint`

## Risks

- **Actor vs. time.** A sub-agent from an earlier turn still running when N is sent writes after the marker; rewinding N reverts those writes. This is the accepted semantics; the dialog states it (phase 3).
- **Live folder ownership.** `deps.workspace` is the folder of the active thread. Requiring `activeThreadId === threadId` for file restore prevents writing into another conversation's folder.
- **Folder name is a weak identity.** Two folders with the same name pass the guard. Accepted in brainstorm; conflict detection limits the damage.
- **Pre-existing:** the per-thread journal is not cleared when a thread changes folder, which still affects the `restore` tool. Out of scope; the marker guard covers rewind only.
