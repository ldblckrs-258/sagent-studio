# Code review: message rewind

Scope: rewind-related changes only (journal seq restore, applyRestore, restore tool refactor, engine rewind, session wiring, message-rewind UI, user footer bar, tests). Pre-existing uncommitted work (runId/run revert, autoContinue, compaction markers) reviewed only where rewind interacts with it.

Verification run (read-only):
- `pnpm vitest run` on the four target files: 112/112 pass.
- `pnpm test`: 142 files, 1706 pass, 1 skipped.
- `pnpm lint`: exit 0. `pnpm exec tsc -p tsconfig.app.json --noEmit`: exit 0, no output.
- Probe (jiti, scratchpad) against `createWorkspaceJournal` confirmed findings H1 and L3.

## Findings

### High

**H1. Rewind silently discards unjournaled content that existed when message N was sent.** `src/workspace/journal.ts:295-302` (planFrom, `touchedOnly` branch) with `change()` at 288-293.
- For a path touched after the marker, the target is `lastBeforeMarker(path).after`, which is the last journaled state. Any unjournaled write between that entry and the marker is ignored. These writes come from the in-app editor save (`src/ui/file-view/use-text-document.ts:68`), panel file creation, or another thread on the same folder.
- Scenario: in turn 1 the agent writes `x.ts` (after `A`). The user fixes `x.ts` in the in-app editor, so it is now `B`, unjournaled. The user sends message 2, and the agent edits `x.ts` (before `B`, after `C`). Rewinding message 2 plans `{content: A, expected: C}`. The file is still `C`, which equals `expected`, so the conflict check passes and `A` is written. The user's `B` is lost. The preview lists `x.ts` under "Restore", not under conflicts. Probe output: `{"path":"x.txt","content":"A-agent-turn1","expected":"C-agent-turn2"}`.
- This contradicts the plan's stated intent: conflict detection is what keeps rewind from clobbering unjournaled writers (phase-01 context; brainstorm decision 2).
- Fix: in `touchedOnly` mode, take the target from `earliestAfterMarker(path, markerSeq).before`. This is the state observed at the first post-marker write; mark the path unrestorable when that entry is partial. Alternatively, when `lastBeforeMarker.after !== earliestAfterMarker.before`, report the path as a conflict and do not restore it. AC1 still holds, because the fixtures have no unjournaled gap. Add a test: record write A, then the marker, then an edit whose `before` is B, and assert the target is B (or a conflict).

### Medium

**M1. The busy check runs once and nothing guards the thread while files are being restored.** `src/chat/engine.ts:709` (check) through `:731-733` (truncate and persist).
- Once `isBusy` passes, nothing stops a run from starting while `applyRestore` does I/O. The concrete trigger is auto-continue (opt-in):
  - `runtime.ts:482-487` removes the sub-agent from `parents` and delivers the notice synchronously.
  - `writeNotice` then awaits `saveThread`, then calls `maybeAutoContinue` and `startRun` (`engine.ts:954`).
- If the user confirms inside that window, the new run streams with N and later messages in its model context. Rewind then cuts `live.messages`, and `updateAssistantMessage` re-appends the streaming reply to the cut thread. That leaves an orphan reply, and the run's tool writes are applied after the restore.
- A notice that lands during the apply is also cut, so the sub-agent report is lost.
- `isBusy` ignores the engine-local signals `this.controllers` and `this.autoContinuing`, which are set earlier than `runningThreads`.
- Fix: add a per-thread `rewinding` set. Set it synchronously right after the busy check and clear it in `finally`. Include `rewinding`, `controllers.has` and `autoContinuing.has` in `isBusy`. Make `startRun` / `maybeAutoContinue` / `writeNotice` defer or refuse while a rewind is in progress.
- Likelihood is low (a narrow window, and auto-continue is off by default), but the outcome is silent thread corruption.

**M2. The folder guard compares against a stored label, not the live folder, and is not re-checked before the write.** `src/chat/engine.ts:1014-1025`.
- `marker.workspace` is compared with `thread.workspaceName`, and `workspace` is captured before `await journalFor`. The label is not the live folder:
  - `bindThread` (`src/session/workspace-state.ts:138-160`) switches `activeThreadId` synchronously but only swaps `fs` after `restoreThread` resolves.
  - `syncWorkspaceLabel` (`src/session/session.ts:297-306`, 315-320) runs only when `fs` changes.
  - A thread with no stored handle adopts the current folder and keeps its old label (`workspace-state.ts:145-151`).
- In these states `files: "ok"` can target another folder. Conflict detection does not stop two things:
  - Re-creating a file the agent deleted after N, because `current` null equals `expected` null.
  - Overwriting byte-identical files in a same-named clone or worktree.
- The modal dialog makes the bindThread window hard to hit. The no-stored-handle path is persistent, though.
- Fix: expose the live folder name and owner through deps (for example `workspaceFor(threadId)` returning `{ api, name }` only when `boundThreadId === threadId` and status is `ready`). Compare `marker.workspace` with the live name. Re-validate owner and `deps.workspace === captured` synchronously next to the busy check before `applyRestore`.

### Low

**L1. The UI throws away the rewind result after a successful apply.** `src/ui/message-rewind.tsx:195-200`.
- Conflicts, skipped files (too large to read), and unrestorable files found at apply time are never shown. Only the preview, taken when the dialog opened, is shown.
- AC4 says "reported". The engine reports them, but the user sees only stale data.
- Fix: when the result differs from the preview, keep the dialog open with a summary.

**L2. The dialog can be dismissed while a rewind is pending.** `src/ui/message-rewind.tsx:213-218`.
- Escape or an overlay click still closes it; only Cancel is disabled. A later `failed` outcome (files partly restored, thread intact) is then never shown.
- Fix: ignore `onOpenChange(false)` while `pending`.

**L3. The marker is a bare `seq` with no journal generation.** `src/workspace/journal-store.ts:113-126`.
- A per-thread journal restarts at seq 0 in three cases: it is loaded while the vault is locked (the empty journal is cached), it fails to decode, or a debounced save is lost on reload.
- Once the new head passes an old marker, `planRestoreAt` plans an unrelated point. Probe: after `clear()` and 5 new writes, marker 2 plans the removal of q2-q4.
- Checkpoint ids have the same issue. Conflict detection bounds the damage.
- Fix: add a persisted random `epoch` to `JournalSnapshot`, stamp it in the marker, and treat a mismatch as `expired`.

**L4. A journal or permission failure blocks even a conversation-only rewind.** `engine.ts:1025` and `683-685`.
- A `journalFor` rejection propagates out of `prepareRewind`, and `previewRewind` throws on `WorkspacePermissionError` (folder not re-granted after a reload, status `denied`). The dialog shows a raw error and Rewind stays disabled.
- When `rewindMarker` swallows a journal failure, the message is later labelled "sent before file rewind existed", which is misleading.
- Fix: map these to a files status with guidance ("grant folder access") instead of an error.

**L5. The UI and engine disagree about busy for a short window, and the preview goes stale.**
- The UI reads `agentRunStore` status `running`. The engine reads the runtime `parents` map. The run stays in `parents` across `await persist` after `store.finish` (`runtime.ts:482-486`).
- As a result Rewind is enabled but the confirm throws the busy error.
- The preview is not refreshed when `busy` flips to false (`message-rewind.tsx:167-184`).

**L6. There are now two conflict-aware apply loops.** `applyRestore` (`journal-io.ts:69-108`) and the pre-existing `applyRunRevert` (`run-journal.ts:20-50`).
- Rewind's `restore` entries carry no label, so `history` cannot tell a user rewind from a model `restore`.
- Suggest a `label` option on `applyRestore` ("rewind"), then folding `applyRunRevert` into it.

**L7. The user footer adds layout height the old bar did not.** `thread.aui.tsx:1012-1015`.
- It reserves `min-h-7.5 pt-1.5` in flow without the assistant root's `-mb-7.5 pb-7.5` cancellation. Every user message grows by about 30px compared with the old absolute bar.
- The `ACTION_BAR_HEIGHT` literal is duplicated.
- Image-only messages (`peer-empty:hidden`) get no Rewind (same as Edit before). Browser QA is still pending.

Test gaps:
- No test for excluding attachment text from `text` (AC2).
- No engine-level `expired` test (AC5).
- No test for `journalFor` rejection meaning no marker.
- No automated UI test for the footer, RewindButton, or RewindDialog (AC8 relies on the pending browser QA).

## Checklist

(a) Acceptance criteria
- AC1 PASS: `journal.test.ts` "workspace journal seq restore". Equality is modulo `expected` and restricted to touched paths, by design.
- AC2 PASS with a gap: engine test "restores files to the moment..." (persisted via `store.get`; edited file restored, created file removed, text returned). Attachment exclusion is implemented (`engine.ts:1005-1009`) but untested.
- AC3 PASS: `it.each(busyCases)`. Race caveat in M1.
- AC4 PARTIAL: the post-agent manual edit is reported (engine and applyRestore tests). A pre-N manual edit is clobbered without a report (H1), and apply-time conflicts are not shown (L1).
- AC5 PASS: folder-mismatch, no-workspace, and no-marker tests; expired is covered at journal level only. The folder guard is weak (M2).
- AC6 PASS: "keeps the thread intact..." and the `applyRestore` failure test.
- AC7 PASS: existing history tests unchanged and green, plus the new `permission_denied` test. The cause is unwrapped at `history.ts:86-90`.
- AC8 UNVERIFIED: the code matches (footer, hover `autohide="not-last"`, Edit kept, `aria-disabled` plus busy tooltip, no-marker stays enabled). There is no automated test and browser QA is pending.

(b) No regression in blast radius: PASS.
- `planRestore` has one caller (`history.ts:73`), and its output is unchanged (`touchedOnly=false` gives `{path, content}` only).
- The barrier is still claimed synchronously: `applyRestore` calls `withWorkspaceLock` before its first await, and the tool has no await between plan and apply. "serializes a read issued in the same step as a restore" passes.
- Metadata readers (`seenPaths`, `convert.ts:177-199`, `usage.ts`, `reducer.editMessage`, `rehydrateThread`) read by key and tolerate the new `rewind` key.
- `editMessage` keeps the marker (the edit is sent by `sourceId`, and only `attachments` is dropped).
- The `journal-store` and `tagJournal` wrappers spread the base, so `head` and `planRestoreAt` pass through and restore entries go through the wrapped `record`, which schedules a save.
- Side effect: `sendTurn` now awaits the journal load before `startRun`, which widens the pre-`beginRun` window slightly. The queue's `dispatching` counter covers double-submit.

(c) Public contracts: PASS (internal app).
- `WorkspaceJournal` gains the required `head` and `planRestoreAt`, and `ChatEngine` gains `previewRewind` and `rewind`. All in-repo implementers compile.
- `RestoreChange.expected`, `ChatMessageMetadata.rewind`, and `PipelineDeps.activeAgentsFor` are optional additions.
- `src/chat/threads.ts` is untouched.

(d) Patterns: PASS with nits.
- The engine is the only message writer (`setThreadMessages` plus `persist`).
- Errors live beside their peers, and the UI uses `useSession` and the dialog primitive.
- New code has no new comments (the `planFrom` comment was moved, not added).
- Nits: `messageOf` is duplicated in `message-rewind.tsx`, and there is the parallel apply loop (L6).

(e) Lint, types, and tests: PASS. Lint 0, tsc 0, target files 112/112, full suite 1706 pass and 1 skipped.

## Unresolved questions
1. H1 fix choice: restore to `earliestAfterMarker.before`, which keeps user edits made after the last journaled write, or report the mismatch as a conflict? Both satisfy decision 2; the conflict route is stricter.
2. Is `aui.thread.composer().setText` captured before the await reliable after the message unmounts under the external-store runtime? This is still `[UNVERIFIED]` in the plan and needs the browser QA.
3. Should rewind be refused, rather than cut the thread, when the folder is present but permission is `denied` (L4)?
4. Is M2's no-stored-handle state reachable for threads created before per-conversation folders that already carry `workspaceName`?
