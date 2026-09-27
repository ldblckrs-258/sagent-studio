---
title: Planned message rewind
date: 2026-09-27
summary: Planned rewind of a user message that restores conversation and workspace files from the per-thread journal.
---

# Planned message rewind

## What happened

Brainstormed and planned a rewind action on user messages: click message N to cut the thread before it and undo workspace file changes made since N was sent. Scouting showed the per-thread write journal (`src/workspace/journal.ts`) already plans restores to a checkpoint, and the apply loop lives inline in the `restore` tool (`src/tools/builtin/history.ts`). Thread-rewriting operations (edit, rerun, undo) live in `src/chat/engine.ts` and `src/chat/reducer.ts`, not `src/chat/threads.ts`, so rewind goes into the engine.

Plan: `plans/260927-1458-message-rewind/` (3 phases: journal seq restore and shared apply, engine rewind, message action bar and dialog). Brainstorm: `plans/reports/brainstorm-260927-2140-message-rewind.md`.

## Decision

- Rewind means "back to before N": N and later messages are removed, files return to the state when N was sent, and N's text replaces the composer draft (the dialog warns first).
- The marker is the journal `seq` at send time plus the folder name, stored in the user message metadata. No checkpoint entry is created, so the journal budget and the model's `history` output are untouched. Edit keeps the original marker.
- The journal gains `head()` and `planRestoreAt(seq)`, which plans only paths touched after the marker. A shared `applyRestore` serves both the tool (unchanged behavior) and rewind (with conflict detection).
- Files changed outside the journal (in-app editor, panel file creation, another thread on the same folder) are skipped and reported as conflicts.
- Rewind is refused while the parent run, any sub-agent of the thread, or a compaction is active.
- A folder-name mismatch, an expired marker, or a legacy message without a marker falls back to a conversation-only rewind.

## Risks

- Revert is time-based, not actor-based: a sub-agent from an earlier turn still writing after N is sent gets reverted too.
- Old markers expire with the journal window (500 entries, 8 MB, 262,144-character per-file cap).
- Pre-existing: the per-thread journal is not cleared when a thread changes folder (`src/session/session.ts:279` clears only the global fallback), which still affects the `restore` tool.
- `src/tools/builtin/guides/checkpoints.md` still says checkpoint ids do not survive a reload, which looks stale since the journal store persists them.

## Next steps

Run `/ak:cook plans/260927-1458-message-rewind/plan.md`. Verify during phase 3 which assistant-ui call reaches the thread composer from a message scope.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
