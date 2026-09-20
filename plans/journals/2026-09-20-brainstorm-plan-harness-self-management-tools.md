---
title: "Brainstorm + Plan: Harness Self-Management Tools"
date: 2026-09-20
summary: "Bounded contract and red-teamed, validated plan for model-callable CRUD over vault skills and custom user tools, gated like write_file."
---

# Brainstorm + Plan: Harness Self-Management Tools

## What happened

Ran `ak:brainstorm` then handed off to `ak:plan` (fast mode) for the request
"implement skills management + tool management tools, allow model to crud skills,
crud custom user tools".

Brainstorm decisions: `write_file`-parity gating (mutations in `GATED_BUILTINS` +
`EDITING_TOOLS`, list tools `READ_ONLY`), separate tool per action, model may set
`enabled` with default false.

Scaffolded `plans/260920-0700-harness-self-management/` via `ak plan create` +
`add-phase`, authored plan.md and three phases, then ran a 3-reviewer red team
(Security Adversary, Failure Mode Analyst, Assumption Destroyer).

Red team found 15 evidence-backed issues, all accepted. The blockers: `create_tool`
could not see builtin-name collisions through the declared port; store-first writes
orphaned vault rows with no rollback; the admin-port factory defaulted to the global
`toolStore` instead of the registry's; Phase 2's claim that `updateSkill` routes
through `register` was false; the six mutation tools were never added to
`EDITING_TOOLS`; `isToolDefinition` rejects the default-disabled tool call; and the
providers were never appended to the hardcoded `builtinProviders` array.

## Decision

Applied all 15 findings. Validation added two decisions: `update_tool({ from, name?,
...patch })` supports rename with rollback; `SkillRegistry.reconcileEnabled` reports
the durable enablement state so a locked policy write returns `enabled: false`
instead of lying.

Documented (not exempted) the skill `allowedTools` narrowing dependency: management
tools are subject to narrowing like every other tool.

Pre-existing, out-of-plan build blocker recorded: `src/vault/UnlockScreen.tsx:81`
passes a numeric HTML `size` into the primitives `Input` (`ControlSize`); Phase 3
owns fixing it so `pnpm build` can go green.

## Next steps

Plan is `pending` and validated; no live task-management surface exists, so the
plan files are authoritative. Execute with
`/ak:cook plans/260920-0700-harness-self-management/plan.md`.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
