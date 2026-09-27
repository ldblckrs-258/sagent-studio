---
phase: 6
title: Cleanup, docs, verification
status: in-progress
---

# Phase 6 — Cleanup, docs, verification

## Steps

1. Delete `src/agents/run-messages.ts` and its test,
   `src/ui/panels/agent-flow-view.tsx` and its test, and any orphaned exports
   (`COMPOSER_SHELL` if it is no longer used).
2. `rg "AgentRunEvent|uiMessagesFromEvents|normalizeThreadMessages|agent-flow-view|appendEvent" src`
   must return nothing.
3. Docs: update `src/tools/builtin/guides/agents.md` and the README section on
   agents only where user-visible behavior changed (full-width run view, open
   actions).
4. Gates: `pnpm test`, `pnpm lint`, `pnpm exec tsc -b`.
5. Ask the user before running `pnpm build` and the browser check. The check is:
   - spawn a background agent that runs `list_dir`, `read_file`, and a failing
     tool;
   - verify real results live, then reload and verify again;
   - steer mid-run, stop a run, and confirm the composer looks the same as the
     main composer.
6. Write the phase report to `reports/` and a journal entry.

## Acceptance

All criteria in `plan.md` are met, with evidence for each (test names, and
screenshots from the browser check).
