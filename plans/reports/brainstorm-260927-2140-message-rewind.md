---
type: brainstorm
date: 2026-09-27
topic: Rewind to a user message (conversation + files)
status: accepted
---

# Brainstorm: message rewind

## Summary

Each user message gets a hover-revealed footer bar (Edit + Rewind). Rewind on message N restores the workspace files to their state at the moment N was sent, truncates the thread to the messages before N, and puts N's text back into the composer. It reuses the per-thread write journal; the only new journal surface is a seq marker and a seq-based restore plan.

## Outcome

- User message action bar moves from the left of the bubble to a footer row under it, right-aligned, hidden until hover (`autohide="not-last"`, same as the assistant bar). It holds Edit and Rewind.
- Rewind opens a confirm dialog that previews: messages removed, files restored, files removed, files unrestorable, and files in conflict.
- On confirm: files are restored first, then the thread is cut to the messages before N and persisted, then N's text is placed in the composer.

## Decisions (accepted)

1. **Semantics: rewind to before N.** N and everything after it are removed; files return to the state just before N was sent. Rewinding the first message restores the pristine workspace.
2. **Conflicts: skip and report.** A file whose current content differs from its last journaled `after` was changed outside the journal (in-app editor save, panel file creation, another thread on the same folder). It is not overwritten; the dialog and the result list it.
3. **Folder guard in the marker.** The marker stores the folder name. If the thread's current folder differs, only the conversation part of the rewind is offered.

## Constraints

- Marker = journal `seq` at send time, stored in the user message metadata. No checkpoint entry is created, so it does not consume the 200-checkpoint / 500-entry budget and does not appear in the model's `history` tool output.
- The marker is stamped once, in `sendTurn`. `editMessage` already preserves metadata (it only drops `attachments`), so an edited message keeps its original marker and a later rewind undoes every branch since N was first sent.
- The restore apply loop currently inlined in `src/tools/builtin/history.ts` is extracted into a shared function so the tool and rewind use one implementation. The tool's behavior stays unchanged.
- Rewind restores only paths with at least one journal entry after the marker. `planRestore` today includes every journaled path; that is harmless for the tool because of the equality skip, but combined with unjournaled edits it would clobber them.
- Rewind is refused while the thread is busy: a parent run is streaming, a sub-agent of the thread is live (`agentRuntime.activeForThread`), or a compaction is in flight. The button is disabled with a tooltip in that state.
- Files are applied before the thread is cut. If applying throws midway, the thread is left intact and the result names the files already restored.
- The engine stays the single writer of thread messages; rewind lives in `ChatEngine`, not in `chat/threads.ts` (which holds conversation CRUD only).

## Non-goals

- Redo or undoing a rewind.
- Forking the conversation into branches.
- Changing Edit, which stays conversation-only.
- Deleting agent run records spawned after N.
- Restoring N's attachments into the composer (text only).
- Rewinding messages sent before this feature (no marker): the button is disabled with a tooltip.
- Fixing the per-thread journal not being cleared on a folder change (see risks).

## Acceptance criteria

- Journal tests: `planRestoreAt(seq)` matches `planRestore(id)` for the same position; a marker older than the retained window or greater than the journal head reports `expired`; only paths touched after the marker are planned.
- Engine tests: rewinding N leaves exactly the messages before N and restores journaled files; rewinding while a run, a live sub-agent, or a compaction is active is rejected without touching files; a file edited outside the journal after N is reported as a conflict and left as is; a folder mismatch restores no files.
- UI: the user action bar renders under the bubble, is hidden until hover, and Rewind is disabled with a tooltip when the thread is busy or the message has no usable marker.

## Touch points

| File | Change |
|------|--------|
| `src/workspace/journal.ts` | `head()`; `planRestoreAt(seq)` with `planRestore(id)` delegating to it |
| `src/workspace/journal-io.ts` | shared restore-apply function with conflict detection option |
| `src/tools/builtin/history.ts` | use the shared apply function |
| `src/chat/sanitize.ts` | `ChatMessageMetadata` gains the rewind marker (`seq`, folder name) |
| `src/chat/engine.ts` | stamp marker in `sendTurn`; `planRewind` / `rewind`; busy guard |
| `src/chat/reducer.ts` | truncate-before helper |
| `src/session/session.ts` | expose sub-agent activity for the thread to the engine deps |
| `src/chat/convert.ts` | surface whether a user message is rewindable |
| `src/components/assistant-ui/elements/thread.aui.tsx` | footer action bar; Rewind button and confirm dialog (`components/ui/dialog.tsx`) |
| `src/tools/builtin/guides/checkpoints.md` | note that user rewinds appear as `restore` entries |

## Risks

- **Time-based, not actor-based.** A sub-agent from an earlier turn that is still running when N is sent writes after the marker; rewinding N reverts those writes too. The dialog states that files return to the moment N was sent.
- **Journal window.** 500 entries, 8 MB of snapshots, and a 262,144-character per-file cap mean old markers expire and large files are unrestorable. The preview shows both.
- **Conversation loss is permanent**, as with Edit today. The confirm dialog is the safeguard.
- **Folder change hazard (pre-existing).** `session.ts:279` clears only the global fallback journal on a folder change, not the per-thread one, so the `restore` tool can write old paths into a new folder. The marker guard covers rewind only.

## Side notes

- `src/tools/builtin/guides/checkpoints.md` says checkpoint ids are process-local and fail after a reload. Since the per-thread journal store persists checkpoints (`journal-codec.ts:67-73`), that line appears stale.
- Unjournaled writers: `src/ui/file-view/use-text-document.ts:68` and `src/ui/panels/workspace.tsx:343`.

## Unresolved questions

- Should the composer prefill target the thread composer explicitly (inside a message scope `aui.composer` may resolve to the edit composer)? To verify during implementation.
