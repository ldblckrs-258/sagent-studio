---
phase: 1
title: "Journal seq restore and shared apply"
status: completed
priority: P1
effort: "3h"
dependencies: []
---

# Phase 1: Journal seq restore and shared apply

## Goal

The journal can plan a restore to a raw `seq` marker (not only a checkpoint id), and one shared function applies a restore plan with optional conflict detection, used by both the `restore` tool and rewind.

## Context

- `src/workspace/journal.ts` — `planRestore(id)` resolves a checkpoint to `checkpoint.seq`, then plans every journaled path via `lastBeforeMarker` / `earliestAfterMarker`.
- `src/tools/builtin/history.ts:70-110` — the apply loop (read current, skip equal, write or remove, record a `restore` entry) is inlined in the `restore` tool under `withWorkspaceLock`.
- Retained entries are contiguous in `seq` (every `record` and `checkpoint` increments `seq` and pushes one entry; pruning only drops from the front), so entries with `seq > m` were evicted exactly when `m < oldestSeq - 1`.
- Unjournaled writers exist: `src/ui/file-view/use-text-document.ts:68`, `src/ui/panels/workspace.tsx:343`. Conflict detection is what keeps rewind from clobbering them.

## Files to Modify

- Modify: `src/workspace/journal.ts`
- Modify: `src/workspace/journal-io.ts`
- Modify: `src/tools/builtin/history.ts`
- Modify: `src/workspace/journal.test.ts`
- Modify: `src/tools/builtin/history.test.ts`

## Tasks & Steps

1. **`head()`** — add `head(): number` to `WorkspaceJournal`, returning the current `seq`. The `journal-store` wrapper spreads the base journal, so it passes through without changes there.
2. **Seq plan** — extract the body of `planRestore` into an internal `planFrom(markerSeq, touchedOnly)` returning `{ changes, unrestorable }`. `planRestore(id)` keeps its exact output by calling it with `touchedOnly = false`.
3. **`planRestoreAt(seq)`** — add to the interface. Returns `{ seq, changes, unrestorable, expired? }` where:
   - `expired: true` when `seq > head()` (journal reset or foreign marker) or when entries exist and `seq < oldestSeq() - 1` (entries after the marker were evicted).
   - Only paths with at least one content entry whose `seq > marker` are planned (`touchedOnly = true`).
4. **Expected content** — extend `RestoreChange` with optional `expected?: string | null`: the `after` of the path's latest content entry, or omitted when that entry is partial. `planRestore` may populate it too; the tool ignores it.
5. **Shared apply** — add to `journal-io.ts`:
   - `applyRestore(journal, workspace, changes, options: { checkConflicts?: boolean })` returning `{ restored, removed, skipped, conflicts }`.
   - Runs under `withWorkspaceLock`. Per change: read current with `readForJournal`; unknown → `skipped`; equal to target → no-op; with `checkConflicts`, `expected` missing or `current !== expected` → `conflicts`; otherwise write or remove and record a `restore` entry (same as today).
   - On a write/remove failure, throw a `RestoreApplyError` (new, in `src/workspace/errors.ts` next to the existing workspace errors) carrying the partial outcome and the failing path.
6. **Tool refactor** — the `restore` tool calls `applyRestore` without `checkConflicts`. Its response fields (`checkpoint`, `restored`, `removed`, `skipped`, `unrestorable`) and error behavior stay identical.
7. **Tests** (`journal.test.ts`):
   - `planRestoreAt(head())` taken before edits equals `planRestore(checkpoint.id)` taken at the same point, for edit, create, and partial cases.
   - A path journaled only before the marker is not planned by `planRestoreAt`.
   - Marker greater than `head()` → `expired`; marker older than the retained window → `expired`.
   - `expected` holds the latest `after`, and is omitted when the latest entry is partial.
8. **Tests** (`history.test.ts`):
   - Existing restore tests stay green unchanged.
   - `applyRestore` with `checkConflicts`: a file rewritten via the workspace directly (not journaled) after the marker lands in `conflicts` and keeps its content.

## Verification

- `pnpm vitest run src/workspace/journal.test.ts src/tools/builtin/history.test.ts`
- `pnpm lint`

## Risks

- Changing `planRestore` through the extraction could shift tool behavior. Mitigation: step 7 compares both planners on identical fixtures, and the existing history tests run unchanged.
- `withWorkspaceLock` must not be re-entered by callers that already hold it. The tool currently wraps the loop itself; after the refactor only `applyRestore` takes the lock.
