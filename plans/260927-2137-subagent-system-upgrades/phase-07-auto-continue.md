---
phase: 7
title: Auto-continue
item: B4
status: completed
---

# Phase 7 — Auto-continue

## Goal

Optionally, a background agent finishing while the conversation is idle wakes the
parent model to act on the result. This is bounded and visible.

## Files

- Modify:
  - `src/vault/settings.ts`: `agents?: { autoContinue: boolean;
    maxAutoContinues: number }`, normalized, defaulting to `{ false, 3 }`.
  - `src/settings/ModelTiersPanel.tsx`: a "Delegation" section with a toggle and
    a number input.
  - `src/chat/engine.ts`: `writeNotice`, idle branch.
  - `src/chat/convert.ts` and `thread.aui.tsx`: the marker rendering.
  - Tests.

## Steps

1. After the engine writes a standalone (idle) notice, when all of the following
   hold:
   - the setting is on;
   - no run is in flight for the thread;
   - the count of auto-continue markers since the user's latest real message is
     below `maxAutoContinues`;

   then append a user message with `metadata.autoContinue = { runId, label }` and
   the text "Sub-agent <label> finished; continue using its result.", and start
   a run.
2. The marker renders as a compact line ("Continued automatically after
   sub-agent X finished"), not a user bubble, in the same way as
   `SkillDirectiveMarker`. `toThreadMessageLike` carries the metadata across.
3. A real user message resets the count, because counting stops at the latest
   message without `autoContinue`.
4. An auto-continued turn that spawns more background agents can chain, and the
   cap bounds it.

## Tests (intent)

- With the setting off, the idle notice starts no run.
- With the setting on, one notice gives one marker and one run, and the model
  receives the marker text as the last user turn.
- The cap is respected: after 3 markers without a user message, no fourth run
  starts. A new user message resets it.
- A notice that arrives while a run is in flight goes inline and never
  auto-continues.
