---
title: "Implemented: Harness Self-Management Tools"
date: 2026-09-20
summary: "Shipped eight model-callable CRUD tools over vault skills and custom user tools via two admin ports, write_file-parity gating, and live panel refresh; all gates green."
---

# Implemented: Harness Self-Management Tools

## What happened

Executed `plans/260920-0700-harness-self-management/` (plan.md + three phases)
sequentially with `/ak:cook`. The feature adds eight builtin tools —
`list_skills`, `create_skill`, `update_skill`, `delete_skill`, `list_user_tools`,
`create_tool`, `update_tool`, `delete_tool` — backed by two optional
`ToolRuntimePorts` members (`skillAdmin`, `toolAdmin`) built by one
`createAdminPorts` factory.

## Decisions carried out

- **Two thin ports over registries, not new stores.** `src/tools/admin-ports.ts`
  adapts `SkillRegistry` and `ToolRegistry`; `ToolRegistry` gained `store()`,
  `hasTool()`, and `replaceUserTool()`. The port reads the registry's own store and
  never falls back to the module-level `toolStore` singleton.
- **Serialized mutations.** `createAdminPorts` runs every create/update/remove
  through one promise chain, so two same-name creates in one turn cannot both pass
  the pre-write collision check.
- **Pre-write checks + rollback.** Builtin/user/vault/workspace collisions are
  checked before any store write; a registry rejection after a write rolls the row
  back. Tool rename via `from` rolls back both rows on partial failure.
- **Durable enablement.** `SkillRegistry.reconcileEnabled` re-reads the persisted
  policy after an `enabled: true` write and reports the durable value, so a
  `VaultLockedError` swallowed by the vault port cannot leave the model believing an
  artifact is enabled. Created artifacts default to disabled.
- **Gating.** Six mutation tools were added explicitly to both `GATED_BUILTINS` and
  `EDITING_TOOLS`; the two list tools joined `READ_ONLY_TOOLS`. No new approval tier.
- **Live refresh.** `SkillRegistry` and `ToolRegistry` gained
  `subscribe`/`getVersion`/`notify`; `notify` is called on `updateSkill` too, which
  bypasses `register`. Both panels now read through `useSyncExternalStore` via
  `src/ui/use-registry-version.ts` instead of a local `version` counter.

## Verification

- `pnpm test`: 63 files, 650 passed, 1 pre-existing skip.
- `pnpm lint`: clean.
- `pnpm build`: green (`tsc -b` + `vite build`).

Two pre-existing build blockers were fixed: the `UnlockScreen` `Input` numeric
`size` conflict and an orphan untracked `src/ui/__preview-ticker.ts` importing the
non-dependency `solid-js`.

## Review outcome

Independent review found no Critical/High defects. Three Medium hardening notes
were left as documented residual/defense-in-depth items: rollback is not
ownership-conditional against a concurrent panel write; the workspace-source guard
lives in the provider rather than the exported port (unreachable via shipped tools);
and a locked-vault *disable* reports the unreadable-policy state (mirror direction of
the reconciled enable case). None block landing.
