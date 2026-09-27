---
title: "Message rewind: restore conversation and files to a user message"
description: "Rewind on a user message restores workspace files to the moment it was sent, cuts the thread before it, and returns its text to the composer."
status: in-progress
priority: P1
effort: 9h
branch: main
tags: [feature, frontend, workspace]
blockedBy: []
blocks: []
created: 2026-09-27
---

# Message rewind

## Overview

Rewind on a user message restores workspace files to the moment it was sent, cuts the thread before it, and returns its text to the composer. It builds on the per-thread write journal that already powers `checkpoint`/`restore`. The user message action bar moves under the bubble and becomes a hover-revealed bar holding Edit and Rewind.

Source decisions: [brainstorm report](../reports/brainstorm-260927-2140-message-rewind.md). Planning mode: fast (scope settled in brainstorm, no external research). Scope: HOLD.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Journal can plan and apply a restore to a raw seq marker, with conflict detection | P1 |
| 2 | Engine stamps a marker on each sent user message and rewinds conversation plus files, refusing while the thread is busy | P1 |
| 3 | User message footer bar (Edit + Rewind) with a confirm dialog that previews the effect | P1 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Journal seq restore and shared apply](./phase-01-start.md) | Completed |
| 2 | [Engine rewind](./phase-02-engine-rewind.md) | Completed |
| 3 | [Message action bar and rewind dialog](./phase-03-message-action-bar-ui.md) | In progress (code and review done; browser QA pending, run by user) |

Phases are sequential: 2 depends on 1, 3 depends on 2.

## Global constraints

- No code comments in new or changed code (user instruction). Existing comments stay untouched.
- Do not run dev or build commands without asking; the dev server is already running. `pnpm test` / `pnpm vitest run <file>` and `pnpm lint` are the verification commands.
- `ChatEngine` stays the only writer of thread messages. `src/chat/threads.ts` is not touched.
- The `restore` tool's observable behavior stays the same.

## Success Criteria

- [ ] `pnpm vitest run src/workspace/journal.test.ts src/tools/builtin/history.test.ts src/chat/engine.test.ts src/chat/reducer.test.ts` passes with the new cases.
- [ ] `pnpm test` and `pnpm lint` pass.
- [ ] Browser-driven check in the running app (GIF recorded): rewind on an earlier message restores edited files, removes files created after it, reports a hand-edited file as a conflict, and puts the message text back in the composer.
- [ ] Rewind is disabled while a run, a sub-agent, or a compaction is active. Messages without a marker offer a conversation-only rewind.

## Validation Log

### Session 1 — 2026-09-27

Verification (Standard tier, self-run): 12 claims checked, 12 verified, 0 failed. `ak plan validate` passed. One `[UNVERIFIED]` item remains by design: the assistant-ui call that reaches the thread composer from a message scope (phase 3, verified during implementation).

| Question | Decision | Effect |
|----------|----------|--------|
| Messages without a marker | Conversation-only rewind, button enabled | Supersedes the brainstorm's "disabled" non-goal. The `rewindable` flag in `convert.ts` is no longer needed and was dropped from phase 2. |
| Composer draft on rewind | Overwrite, with a warning in the dialog | Phase 3 steps 4 and verification updated. |
| Manual QA | Agent drives the running app via Chrome automation and records a GIF | Phase 3 verification updated. |

## Review — 2026-09-27

[Code review report](../reports/code-reviewer-260927-2259-message-rewind.md). Lint, typecheck, and `pnpm test` pass (1710 passed, 1 pre-existing skip).

- Fixed (user decision): rewind restored the last journaled state before the marker, which overwrote an unjournaled hand edit made before the message. `planRestoreAt` now targets the `before` of the first journaled write after the marker. `planRestore` and the `restore` tool are unchanged. Regression tests are in `journal.test.ts` and `engine.test.ts`.
- Implementation deviations: the dialog state lives on `UserMessage` because the autohide action bar can unmount on hover loss. Rewind is hidden on messages outside the active conversation because the sub-agent run view renders the same `UserMessage`. The button uses `aria-disabled` so the busy tooltip still shows.
- Deferred, not applied: guarding against a run started by auto-continue during the restore, comparing against the live folder name instead of `thread.workspaceName` while `bindThread` is switching folders, locking the dialog while a rewind is pending, and extra engine tests (attachment text excluded, expired marker, failed journal load). Also low-severity: bare seq marker after a journal reset, `applyRestore` duplicating `applyRunRevert`, unlabeled `restore` entries, and about 30px of reserved footer height per user message.

<!-- slug: message-rewind -->
