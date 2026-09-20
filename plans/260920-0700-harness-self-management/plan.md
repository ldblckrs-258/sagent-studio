---
title: "Harness Self-Management — Model CRUD for Skills and User Tools"
description: "Add builtin tools that let the model list, create, update, and delete vault skills and custom user tools, gated like write_file and surfaced live in the Skills and Tools panels."
status: implemented
priority: P1
effort: 18h
branch: main
tags: [feature, ai, tools, skills, security]
created: 2026-09-20
---

# Harness Self-Management — Model CRUD for Skills and User Tools

## Overview

Today the model can call tools but cannot manage them. Skills are imported from
the Skills panel (`src/ui/panels/skills.tsx:133`), and custom user tools are
authored in the Tools panel (`src/ui/panels/tools.tsx:224`). The model can load an
enabled skill (`load_skill`) but cannot create one, and it can call a user tool
but cannot define one. Any capability gap the user does not pre-build stays a gap
for the whole conversation.

This plan gives the model a bounded management surface over its own harness:
eight new builtin tools — `list_skills`, `create_skill`, `update_skill`,
`delete_skill`, `list_user_tools`, `create_tool`, `update_tool`, `delete_tool` —
backed by two new optional ports (`SkillAdminPort`, `ToolAdminPort`) that wrap the
existing `SkillRegistry` / `ToolRegistry` / encrypted stores. Mutation tools are
gated exactly like `write_file`; list tools are read-only. Every model-driven
mutation becomes visible in the live Skills and Tools panels.

All work is additive to `ToolProvider` / `ToolRegistry` / `ToolRuntimePorts`
(`src/tools/types.ts:128`), to `SkillRegistry` (`src/skills/registry.ts:20`), and
to the existing panel surfaces.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | `SkillAdminPort` and `ToolAdminPort` wrap the existing registries and encrypted stores; both sit on `ToolRuntimePorts` as optional members | P1 |
| 2 | The model can `list_skills` and `list_user_tools` with name, kind/source, description, and enabled state | P1 |
| 3 | The model can `create_skill` / `update_skill` / `delete_skill` for vault skills only; workspace skills are read-only, and created skills default to disabled | P1 |
| 4 | The model can `create_tool` / `update_tool` / `delete_tool` for `sandbox-js` and `http` user tools, reusing `validateToolName`, `assertPlainSchema`, and `assertHttpDefinition` | P1 |
| 5 | Mutation tools are gated exactly like `write_file` and list tools are ungated read-only tools | P1 |
| 6 | Model mutations appear live in the Skills and Tools panels without a manual refresh | P2 |
| 7 | Full suite, lint, and build stay green; expected failures return structured envelopes (`conflict`, `not_found`, `invalid_input`, `permission_denied`) | P1 |

## Contract

**Outcome.** A model-managed harness. Through eight new builtin tools the model
lists, creates, updates, and deletes vault skills and custom user tools.
Created/updated definitions persist in the encrypted vault, survive reload, and
appear in the Skills and Tools panels. Workspace skills stay read-only. Created
skills and tools start disabled unless the caller explicitly sets `enabled: true`.

**Constraints.**

- Browser-only. No new dependency, no Node API. `pnpm build` runs `tsc -b`
  against a DOM-only `lib` (`tsconfig.app.json`).
- Reuse the existing persistence and validation seams: `SkillRegistry`
  (`importSkill`/`updateSkill`/`removeSkill` at `src/skills/registry.ts:119-145`),
  `ToolRegistry` (`registerUserTool`/`removeUserTool`/`setEnabled` at
  `src/tools/registry.ts:59-80`), `skillStore` (`src/skills/store.ts:60`) and
  `toolStore` (`src/tools/store.ts:114`), plus `isSkillManifest`, `validateToolName`,
  `assertPlainSchema`, and `assertHttpDefinition`. No new storage layer, no
  envelope version bump.
- Ports are assembled in two places — `buildRunStream`
  (`src/chat/engine.ts:216`) and `builtinProviders` (`src/session/session.ts:241`)
  — so one shared factory builds both admin ports and both call sites consume it.
- Mutation tools are added explicitly to **both** `GATED_BUILTINS` and
  `EDITING_TOOLS` (`src/tools/approval.ts:14`, `:34`) so they behave exactly like
  `write_file`: permitted by policy in `editing`, above-ceiling in `read_only`,
  auto-approved in `god`, and blockable by a persisted `deny`. List tools join
  `READ_ONLY_TOOLS` (and thus `EDITING_TOOLS` via its spread).
  <!-- Updated: Red Team Session 1 - the READ_ONLY spread does not carry mutation tools; add both sets explicitly -->
- Management tools are **subject to skill `allowedTools` narrowing**, like every
  other tool. When an enabled skill declares a non-empty `allowedTools`, only the
  intersection with the available pool reaches the model
  (`src/chat/engine.ts:225-237`); the management tools are then available only if
  that skill lists them. This is a documented limitation, not a bug: a skill
  controls the tool pool by design.
  <!-- Updated: Red Team Session 1 - narrowing dependency documented, no exemption -->
- No secrets in logs, errors, or plaintext persistence. Skill and tool bodies stay
  encrypted in the vault.
- `pnpm test`, `pnpm lint`, and `pnpm build` stay green.

**Non-goals.**

- Model editing, deleting, or renaming workspace-sourced skills (read-only by
  design, matching `src/ui/panels/skills.tsx:307`).
- Model renaming a **skill**. `update_skill` edits fields in place by `id`; a skill
  rename is delete-plus-create.
  <!-- Updated: Validation Session 1 - tool rename is in scope; skill rename is not -->
- Model changing approval policy, chat mode, providers, or vault settings.
- Model toggling workspace skill enablement. Only vault skill `enabled` is a
  writable field.
- Skill/tool versioning, history, diffing, or import from Markdown via tool
  (`importSkill` stays UI-only).
- Making a newly created artifact callable within the same turn. The tool set and
  system prompt are built at run start (`src/chat/engine.ts:216-242`), so a new
  skill/tool takes effect on the next turn. This is documented, not fixed.
- MCP, subagents, and RAG.

**Acceptance criteria.**

1. `list_skills` returns every registered skill with `id`, `name`, `description`,
   `source`, `enabled`, and `allowedTools`; `list_user_tools` returns every user
   tool with `name`, `kind`, `description`, `enabled`, and a one-line summary
   (`METHOD url` for http, `sandbox` plus timeout for sandbox-js).
2. `create_skill` on a new id persists an encrypted vault skill, registers it,
   returns it disabled by default, and a reload re-hydrates it; a duplicate id
   (vault or workspace) returns `conflict`. When `enabled: true` is requested, the
   returned `enabled` reflects the **durable** enablement state: if the policy write
   did not persist (vault locked), the result is reconciled to `enabled: false`.
   <!-- Updated: Validation Session 1 - reconcile enabled against the persisted policy -->
3. `update_skill` patches only the supplied fields of an existing vault skill and
   preserves the rest; an unknown id returns `not_found`; a workspace target
   returns `permission_denied` and mutates nothing.
4. `delete_skill` removes a vault skill and its enablement; a workspace target
   returns `permission_denied`; an unknown id returns `not_found`.
5. `create_tool` accepts a `sandbox-js` or `http` definition, validates name,
   schema, and HTTP shape through the existing validators, persists it disabled by
   default, and surfaces it in `ToolRegistry.list()`; a name that collides with a
   builtin or an existing user tool returns `conflict`; `update_tool({ from, name?,
   ...patch })` edits the tool identified by `from` and renames it when `name`
   differs, rolling back on a partial failure; `delete_tool` removes it and its vault
   record.
   <!-- Updated: Validation Session 1 - update_tool rename via `from` -->
6. In `createToolApproval`'s map, the six mutation tools are present with
   `user-approval` in `editing` (empty policy) and `read_only`, and present with
   `approved` in `god`; the two list tools are absent from the map in every mode.
   <!-- Updated: Red Team Session 1 - gated tools stay in the god map as 'approved'; they are not absent -->
7. A model-created skill or tool appears in the Skills/Tools panel without a manual
   refresh after the turn ends, including after an `update_skill` / `update_tool`
   mutation.
   <!-- Updated: Red Team Session 1 - updateSkill bypasses register, so it must notify explicitly -->
8. When an enabled skill declares a non-empty `allowedTools`, the management tools
   are excluded unless the skill lists them (documented narrowing limitation).
   <!-- Updated: Red Team Session 1 - narrowing dependency documented -->
9. Every expected failure is a structured envelope; only runtime-unavailable
   conditions throw. `pnpm test`, `pnpm lint`, and `pnpm build` pass.

## Key Decisions

- **Two thin admin ports instead of new stores.** `SkillAdminPort` and
  `ToolAdminPort` adapt the existing registries; the tool providers hold validation
  and result shaping. Each port exposes the ownership predicate the provider needs:
  `SkillAdminPort.exists(id)` checks both vault and workspace, and
  `ToolAdminPort.hasTool(name)` sees provider-owned names as well as user tools.
  <!-- Updated: Red Team Session 1 - ports must expose builtin/cross-source collision detection -->
- **A shared `createAdminPorts` factory.** `src/tools/admin-ports.ts` exports
  `createAdminPorts(registries: { skillRegistry: SkillRegistry; toolRegistry:
  ToolRegistry }): { skillAdmin: SkillAdminPort; toolAdmin: ToolAdminPort }`, backed
  by the registries' own stores (no global-singleton default). `buildRunStream`
  (`src/chat/engine.ts:216`) and `builtinProviders` (`src/session/session.ts:241`)
  both call it, so the availability the panel shows cannot drift from what a run can
  call.
  <!-- Updated: Red Team Session 1 - factory signature specified; use registry store, not global -->
- **Admin mutations are serialized.** The factory runs every create/update/remove
  through one promise chain, so the check-then-write window cannot interleave two
  same-name calls from a single turn.
  <!-- Updated: Red Team Session 1 - check-then-await race -->
- **`write_file`-parity gating, per the accepted brainstorm decision.** Mutation
  tools are added explicitly to `GATED_BUILTINS` **and** `EDITING_TOOLS`; list tools
  to `READ_ONLY_TOOLS`. No new approval tier.
  <!-- Updated: Red Team Session 1 - add both sets explicitly -->
- **Provider-owned failures.** Expected conditions return `toolFail('conflict' |
  'not_found' | 'invalid_input' | 'permission_denied')` directly; `wrapToolExecute`
  (`src/tools/result.ts:128`) maps only unexpected errors. `ToolNameConflictError`
  is not in `CODE_BY_ERROR_NAME`, so providers must not rely on it for the code.
  Every conflict/not-found check runs **before** any store write, and a store write
  that is followed by a registry rejection is rolled back (the panel's
  `save`-then-`registerUserTool` rollback at `src/ui/panels/tools.tsx:397-425` is the
  precedent).
  <!-- Updated: Red Team Session 1 - store-first write orphans rows without rollback -->
- **Workspace skills are immutable through tools.** The provider rejects
  `source: 'workspace'` for update/delete with `permission_denied`, mirroring the
  panel's read-only marker.
- **Created artifacts default disabled, and the reported state is durable.**
  `enabled` is an accepted field, but its default is `false`. When `enabled: true`
  is requested, the admin port calls `SkillRegistry.reconcileEnabled(ref)` after the
  policy write, re-reads the persisted policy (`SkillEnablementPort.load`), and
  reports `enabled` from that value — so a `VaultLockedError` swallowed by
  `createVaultSkillEnablement.save` (`src/skills/enablement.ts:28`) cannot leave the
  model believing an artifact is enabled when a reload will not honor it.
  `SkillRegistry.hydrate` still enables every stored manifest when no
  `SkillEnablementPort` is supplied (`src/skills/registry.ts:170`); that is recorded
  as a residual risk.
  <!-- Updated: Red Team Session 1 - disabled-default guarantee is conditional; god/allow-always bypass approval -->
  <!-- Updated: Validation Session 1 - reconcile enabled against the persisted policy -->
- **Tool `update` supports rename.** `ToolRegistry` gains `hasTool(name)` and
  `replaceUserTool(definition)`; `replaceUserTool` rejects only a provider name or a
  *different* user entry. `ToolAdminPort.update(from, definition)` handles the case
  where `definition.name !== from` by removing the old row/entry and registering the
  new one, rolling back on failure. Skill rename stays out of scope.
  <!-- Updated: Red Team Session 1 - replaceUserTool must allow the tool's own name -->
  <!-- Updated: Validation Session 1 - update_tool supports rename via `from` -->
- **Registry change notification, not a new store.** `SkillRegistry` and
  `ToolRegistry` gain `subscribe`/`getVersion`; panels read it through
  `useSyncExternalStore`. `notify()` is called from `register`, **`updateSkill`**
  (which bypasses `register`), `setEnabled`, `removeSkill`, and the tool-registry
  mutation methods. This is the smallest change that makes model mutations visible
  live.
  <!-- Updated: Red Team Session 1 - updateSkill bypasses register; notify explicitly -->

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Admin Ports and Management Tools](./phase-01-admin-ports-and-management-tools.md) | Implemented |
| 2 | [Live Panel Refresh](./phase-02-live-panel-refresh.md) | Implemented |
| 3 | [End-to-End Verification and Hardening](./phase-03-end-to-end-verification-and-hardening.md) | Implemented |

Phases are strictly sequential. Phase 2 touches the registries and panels that
Phase 1 leaves alone except for the two additive `ToolRegistry` methods; Phase 3
is the verification gate over both.

## Cross-Plan Dependencies

Additive to [Harness Tools — Autonomous Core](../260919-1821-harness-tools/plan.md)
(`status: implemented`), which owns `ToolRuntimePorts`, `ToolProvider`,
`ToolRegistry`, the approval engine, `SkillRegistry`, and the progressive-skill
surface this plan extends.

Known consumers that must still compile and pass:

- `ToolRuntimePorts` producers: `src/chat/engine.ts:216` and
  `src/session/session.ts:241` (`builtinProviders`); both are updated in one phase.
- `builtinProviders` returned-array consumers: `src/ui/panels/tools.tsx:329` and
  `src/ui/panels/approvals.tsx:22`. Appending the two providers to the array makes
  the six mutation tools appear in `ApprovalsPanel` (via `isGatedTool`); that is a
  required consequence of the requested gating, not added scope, and it is covered
  by a test.
- `buildRunStream` call sites: `src/chat/engine.ts:537` (`executeRun`) and
  `src/chat/transport.ts:14` (`sendMessages`).
- `ToolRegistry` callers: `src/session/session.ts:176-183`,
  `src/ui/panels/tools.tsx`, `src/tools/registry.test.ts`,
  `src/chat/harness-e2e.test.ts`.
- `approval.ts` consumer tests: `src/tools/approval.test.ts`,
  `src/chat/approval.test.ts`. `change_mode`'s always-ask behavior and the existing
  `god` expectation (`src/chat/approval.test.ts:41-46`) must not change.

## Dependencies

| Relationship | Plan | Status |
|--------------|------|--------|
| Additive to | `plans/260919-1821-harness-tools` | implemented |
| Blocked by | none | — |

## Risk Summary

| Risk | Likelihood × impact | Mitigation |
|------|---------------------|------------|
| The model persists a malicious skill/tool without an explicit user enable step | Medium × High | Created artifacts default `enabled: false`. The default is not an approval barrier: in `god` mode gated tools auto-approve, and a single "allow-always" persists an `allow` for the tool, so a caller-supplied `enabled: true` can be honored without a per-call accept. Residual, accepted risk from the brainstorm's `write_file`-parity decision; recorded honestly here. |
| A created tool shadows a builtin or an existing user tool | Medium × High | `ToolAdminPort.hasTool(name)` is checked before any store write, plus `registerUserTool`'s conflict; a test asserts `code: 'conflict'` and that `store.save` was never called. |
| A registry rejection after a successful store write leaves an orphan vault row | Medium × High | Conflict/not-found checks run before the write, and the write is rolled back if the registry subsequently throws; a test asserts the row is gone. |
| Panel and run disagree about which management tools are available | Medium × Low | One `createAdminPorts` factory with a specified signature, used by both `buildRunStream` and `builtinProviders`. |
| Two same-name creates in one assistant turn both pass the check | Medium × High | `createAdminPorts` serializes create/update/remove through one promise chain; a test issues two concurrent creates and asserts one succeeds and one returns `conflict`. |
| `ToolRegistry` mutation from a model turn races the panel's own edit | Low × Medium | Both paths go through the same registry methods; the vault write queue serializes the store writes; panels re-render from the registry version. |
| A created skill's `enabled: true` silently reverts to disabled after reload | Medium × Medium | `SkillRegistry.reconcileEnabled` re-reads the persisted policy after the write and returns the durable value; a locked write is reported as `enabled: false`. Residual: a later vault lock can still make a persisted policy temporarily unreadable, which reads as disabled until unlock. |
| A failed tool rename leaves the store and registry inconsistent | Low × Medium | `ToolAdminPort.update` validates the new name (`hasTool`) before writing and rolls back the store row and registry entry on a partial failure; a test forces the failure path. <!-- Updated: Validation Session 1 - rename handled with rollback --> |
| Skill/tool description or instructions carry a prompt-injection payload | Medium × Medium | Skill bodies are only ever returned through `load_skill`; vault skills are user-enabled. Tool descriptions enter the model prompt only when the tool is enabled and are gated on call. Residual, documented. |
| Provider failure uses a thrown `ToolNameConflictError` and surfaces as `runtime_error` | High × Low | Providers return `toolFail('conflict', ...)` directly and a test asserts the code. |
| Model update clobbers fields it did not intend to change | Medium × Medium | `update_skill` / `update_tool` merge supplied fields over the current definition; tests assert untouched fields survive. |

## Success Criteria

- [x] All seven goals are implemented and each has an automated test naming the
      behavior it protects.
- [x] Acceptance criteria 1-9 are evidenced by `pnpm test`; criterion 9 also by a
      green `pnpm lint` and `pnpm build`.
      <!-- Updated: Red Team Session 1 - criterion renumbered after the narrowing criterion was added -->
- [x] A created skill and a created tool survive a store round-trip through
      `skillStore` / `toolStore` and re-hydrate into `SkillRegistry` /
      `ToolRegistry`.
- [x] No mutation is possible against a workspace skill, proven by a test.
- [x] Mutation tools are `user-approval` in `editing` and `read_only` and
      `approved` in `god`; the list tools are absent from the approval map, proven
      by `createToolApproval` tests.
      <!-- Updated: Red Team Session 1 - god keeps gated entries with 'approved' -->
- [x] A builtin-name collision returns `conflict` and writes no store row, proven by
      a test.
- [x] Each phase's rollback is a pure revert of that phase's files and leaves the
      suite green.

## Red Team Review

### Session 1 — 2026-09-20
**Findings:** 15 deduplicated (15 accepted, 0 rejected on merit)
**Severity breakdown:** 2 Critical, 8 High, 5 Medium
**Reviewers:** Security Adversary (Fact Checker), Failure Mode Analyst (Flow Tracer), Assumption Destroyer (Contract Verifier)

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | `create_tool` cannot see builtin-name collisions through `ToolAdminPort.get` | Critical | Accept | Phase 1, plan.md |
| 2 | Store-first write with no rollback orphans a vault row | High | Accept | Phase 1, plan.md |
| 3 | `createToolAdminPort` defaults to the global `toolStore`, not the registry's store | Critical | Accept | Phase 1, plan.md |
| 4 | Phase 2 premise false: `updateSkill` bypasses `register` and never notifies; removing local `setVersion` regresses panel edit refresh | High | Accept | Phase 1, Phase 2 |
| 5 | Six mutation tools never added to `EDITING_TOOLS` | High | Accept | Phase 1, plan.md |
| 6 | `isToolDefinition` requires `enabled: boolean`, rejecting the default-disabled create | High | Accept | Phase 1 |
| 7 | Providers never appended to the hardcoded `builtinProviders` array | High | Accept | Phase 1 |
| 8 | `ApprovalsPanel` consumes both changed surfaces and was omitted from every file list | High | Accept | Phase 1, plan.md |
| 9 | Check-then-await race: two same-name creates in one turn both pass | High | Accept | Phase 1, plan.md |
| 10 | Cross-source skill duplicate must check vault **and** workspace | Medium | Accept | Phase 1 |
| 11 | `persistEnabled` swallows `VaultLockedError`; created-`enabled` silently reverts | Medium | Accept | Phase 1, plan.md |
| 12 | Acceptance #6 wrong: mutation tools are present in `god` as `approved`, not absent | High | Accept | plan.md, Phase 3 |
| 13 | `replaceUserTool` spec self-contradicts; `summaryOf` not on the port; summary string mismatch | Medium | Accept | Phase 1 |
| 14 | Skill `allowedTools` narrowing can exclude the management tools | Medium | Accept | Phase 1, plan.md |
| 15 | Doc/anchor errors: nonexistent `src/skills/store.test.ts`, `toolNamesOf` location, "Phase 4" reference, drifted line anchors | Medium | Accept | all phases |

**Rejected:** Finding 8's implicit "ApprovalsPanel change is unrequested scope"
framing — the panel rows are a required consequence of the requested gating, not
added scope. No finding was rejected for missing evidence.

### Whole-Plan Consistency Sweep
- Files reread: plan.md, phase-01-admin-ports-and-management-tools.md,
  phase-02-live-panel-refresh.md, phase-03-end-to-end-verification-and-hardening.md
- Decision deltas checked: 8 (port ownership predicates; factory signature and
  store source; serialization; explicit `EDITING_TOOLS`; `enabled` default and
  residual risk; provider array; notification on `updateSkill`; narrowing
  limitation; criterion renumbering)
- Reconciled stale references: 3 (two remaining `session.ts:208` anchors; one
  `acceptance criteria 1-8` reference in Phase 3)
- Unresolved contradictions: 0

## Validation Log

### Validation Session 1 — 2026-09-20
Verification tier: Standard (3 phases) — Fact Checker + Contract Verifier, run
inside the red-team reviewers.
Questions asked: 4 (2 in brainstorm, 2 in this session)

| # | Question | Decision |
|---|----------|----------|
| 1 | Skill/tool CRUD authority and gating | `write_file`-parity: mutations gated in `GATED_BUILTINS` + `EDITING_TOOLS`; model may set `enabled`; default false. |
| 2 | Management-tool granularity | Separate tool per action. |
| 3 | Tool rename | `update_tool({ from, name?, ...patch })` supports rename via `from`, with rollback. Skill rename stays out of scope. |
| 4 | Enablement durability on a failed policy write | `reconcileEnabled` re-reads the persisted policy and reports the durable state; a locked write reports `enabled: false`. |

Propagation: Goals/Contract/Key Decisions/Risk/Success Criteria and all three phase
files updated; `update_tool` schema gained `from`; admin ports gained rename
rollback and enablement reconciliation.
<!-- Updated: Validation Session 1 - tool rename and enablement reconcile -->

### Verification Results
- **Tier:** Standard
- **Claims checked:** 30
- **Verified:** 27 | **Failed:** 0 | **Unverified:** 3 (fixed in this session)

#### Notes
1. All failed claims were line anchors and one nonexistent test path; corrected in
   this session. No semantic claim failed verification.
2. The `pnpm build` status was not run during review (reviewers were read-only for
   build); Phase 3 owns confirming it and fixing the pre-existing `UnlockScreen`
   type error if still present.

### Whole-Plan Consistency Sweep
- Files reread: plan.md, all three phase files
- Decision deltas checked: 10 (the 8 red-team deltas plus tool rename and
  enablement reconciliation)
- Reconciled stale references: 3 (two remaining `session.ts:208` anchors; one
  `acceptance criteria 1-8` reference in Phase 3)
- Unresolved contradictions: 0

## Implementation Results

Implemented across all three phases. Gate evidence at completion:

- `pnpm test`: 63 files, 650 passed, 1 pre-existing skip.
- `pnpm lint`: clean.
- `pnpm build`: green (`tsc -b` + `vite build`).

Two pre-existing build blockers were fixed in Phase 3: the
`src/vault/UnlockScreen.tsx` `Input` numeric `size` conflict, and an orphan
untracked `src/ui/__preview-ticker.ts` importing the non-dependency `solid-js`.

Independent code review found no Critical/High defects. Three Medium hardening
observations were recorded and left as documented residual/defense-in-depth
items: (M1) rollback is not ownership-conditional against a concurrent panel
write (plan's accepted Low × Medium cross-path race); (M2) the vault/workspace
guard lives in the provider, not the exported port (unreachable through shipped
tools); (M3) a locked-vault disable reports the unreadable-policy state
(documented residual for the mirror direction of the `enabled: true` case).
