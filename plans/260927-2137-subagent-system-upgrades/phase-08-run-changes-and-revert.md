---
phase: 8
title: Per-run changes and revert
item: C1
status: completed
---

# Phase 8 — Per-run changes and revert

## Goal

Every workspace change a child makes is attributable to its run. The user can
see the changed files and revert one run without touching other work.

## Files

- Modify:
  - `src/workspace/journal.ts`: `JournalEntry.runId?`, `changesForRun`,
    `planRunRevert`.
  - `src/workspace/journal-codec.ts`: round-trips `runId`.
  - `src/workspace/journal-io.ts` if needed.
  - `src/session/session.ts`: `portsFor(context, runId)` wraps the journal;
    `agentRunChanges`, `revertAgentRun`.
  - `src/agents/runtime.ts`: passes `runId` to `portsFor`, and collects
    `filesChanged` at settle.
  - `src/agents/types.ts`: `AgentRunResult.filesChanged?`.
  - `src/tools/builtin/agents.ts`: outputs.
  - `src/chat/types.ts`: the notice report `filesChanged`.
  - `src/ui/agent-run-view.tsx`: section placement.
  - The report card: count.
- Add: `src/workspace/run-journal.ts` (`tagJournal`), `src/ui/run-changes.tsx`,
  and their tests.
- Read first: `src/tools/builtin/history.ts` (how `restore` applies a plan with
  path locks and records `restore`) and `src/workspace/journal-store.ts`.

## Steps

1. `tagJournal(journal, runId)` returns a `WorkspaceJournal` whose `record` adds
   `runId`. Every other method delegates. The session uses it in `portsFor` for
   child runs.
2. `changesForRun(runId)` returns, per path:
   - `before` from the run's first entry and `after` from its last entry;
   - the kind, a `partial` flag, and line counts from `diff`.
3. `planRunRevert(runId)` returns, per path:
   - target content = the run's first `before`;
   - a conflict when a later entry not from this run touched the path;
   - unrestorable when an entry was partial.
4. Applying the revert (session):
   - Re-check at apply time that the current file content equals the run's last
     `after`. If not, it is a conflict.
   - Write or remove under the path lock, recording a `restore` entry labelled
     `revert run <label|id>`.
   - Return `{ reverted, conflicts, unrestorable }`.
5. At settle the runtime computes `filesChanged` (paths) and puts it into the
   result, the notice report, and the wait results.
6. UI:
   - `RunChanges` in the run view lists each file with `+a −r`, with an
     expandable diff.
   - The **Revert this run** button needs a two-step confirmation ("Revert N
     files?" then Confirm).
   - The outcome summary lists the skipped files and why.
   - The report card shows "N files changed".

## Tests (intent)

- A child `write_file` produces a journal entry with the child's `runId`. A
  parent write has none.
- The codec round-trips `runId`, and an old journal without it loads.
- `changesForRun` merges several edits to one path into first-before and
  last-after.
- The revert restores untouched files. A file later edited by the parent is
  skipped as a conflict and left as it is. A partial entry is unrestorable.
- The revert is itself recorded, so a checkpoint restore can undo it.
- The UI lists the files, needs confirmation, and shows the outcome.
