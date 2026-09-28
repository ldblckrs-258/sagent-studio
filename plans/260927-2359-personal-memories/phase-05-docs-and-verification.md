---
phase: 5
title: Docs and verification
status: completed
priority: P2
effort: 1h
dependencies: [1, 2, 3, 4]
---

# Phase 5 — Docs and verification

## Goal

User-facing docs describe memories and their data flow, and every gate passes.

## Files

- Modify:
  - `README.md`
  - `plans/README.md` (index row)

## Steps

1. **`README.md`.**
   - Add a "What you can do" bullet: the model remembers facts about you across conversations; memories are global or per folder; manage them in the Memory panel.
   - Add a "Personal memories" section covering:
     - **Saving.** What the model saves and when. It saves without asking; sub-agents cannot save.
     - **Scope.** Global versus per-folder memories. A folder is recognised by its handle, not by its name.
     - **The `important` flag.** Its effect, and the budget of 2,000 characters per scope.
     - **Limits.** The size limits.
     - **Management.** The panel.
     - **Turning the no-prompt behaviour around.** A `deny` in approvals.
   - Under "Your data and what leaves your machine":
     - memories are encrypted like conversations;
     - the memory index and important bodies go to the chat provider in every turn's system prompt;
     - the folder handle of a workspace scope is stored in the clear, like every folder grant.
2. **`plans/README.md`.** Add an index row for this plan.
3. **Gates.** Run:
   - `pnpm exec vitest run`, and record the test count against the baseline;
   - `pnpm exec tsc -b`;
   - `pnpm lint`.
4. **Code review.** Review the diff with the code review skill, and fix the confirmed findings.
5. **Build and browser check.** Only with the user's go-ahead.

## Verification

- All three gates pass.
- Every acceptance criterion in `plan.md` maps to a named test or a recorded browser check.
