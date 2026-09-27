---
phase: 9
title: Docs, review, verification
status: completed
---

# Phase 9 — Docs, review, verification

## Steps

1. `src/tools/builtin/guides/agents.md` (the model-facing guide) covers:
   - profiles (the `agent` param, available ids, and a pointer to
     `.agents/agents/*.md`);
   - `outputSchema`;
   - `message_agent` (steer or continue);
   - `wait_agents` (fan-out/gather);
   - `filesChanged`;
   - the report format children follow.
   Keep it concise, since it counts against the model's context.
2. `README.md`, agents section:
   - profiles and the workspace profile format;
   - continue/resume;
   - gather;
   - the auto-continue setting;
   - files changed and revert.
3. Run a code-reviewer subagent with the acceptance criteria from `plan.md`. Fix
   the confirmed findings, each with a test.
4. Gates: `pnpm test`, `pnpm lint`, `pnpm exec tsc -b`.
5. Ask the user before running the build and the browser check. The check
   covers:
   - a profile spawn;
   - an output schema;
   - a long run that crosses the compaction threshold;
   - continue after a reload;
   - fan-out of 3 agents plus `wait_agents`;
   - auto-continue on and off;
   - revert with one conflicting file.
6. Write reports and a journal entry, and update the plan status.
