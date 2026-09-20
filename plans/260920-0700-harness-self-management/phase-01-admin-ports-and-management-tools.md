---
phase: 1
title: "Admin Ports and Management Tools"
status: implemented
priority: P1
effort: "10h"
dependencies: []
---

# Phase 1: Admin Ports and Management Tools

## Context Links

- Plan: [`plan.md`](./plan.md) — goals 1-5; Key Decisions "Two thin admin ports",
  "A shared `createAdminPorts` factory", "Admin mutations are serialized",
  "Provider-owned failures".
- Port seam: `src/tools/types.ts:128` (`ToolRuntimePorts`), `:138` (`ToolProvider`),
  `:118` (`SkillLoadPort`).
- Registry seams: `src/skills/registry.ts:119` (`importSkill`), `:129`
  (`updateSkill`), `:139` (`removeSkill`), `:31` (`register`), `:52` (`setEnabled`);
  `src/tools/registry.ts:59` (`registerUserTool`), `:77` (`removeUserTool`), `:71`
  (`setEnabled`), `:82` (`list`), `:86` (`userToolKind`).
- Stores: `src/skills/store.ts:60` (`skillStore`), `src/tools/store.ts:114`
  (`toolStore`); validators `src/tools/types.ts:187` (`validateToolName`), `:197`
  (`assertPlainSchema`), `src/tools/store.ts:9` (`assertHttpDefinition`),
  `src/skills/schema.ts:35` (`isSkillManifest`).
- Provider pattern to copy: `src/tools/builtin/code.ts:45` and
  `src/tools/builtin/plan.ts:9` — a `names` tuple, `isAvailable(ports)`, and
  `create(name, ports)` returning a `tool({ description, inputSchema, execute })`.
- Result seam: `src/tools/result.ts:64` (`toolFail`), `:55` (`toolOk`), `:128`
  (`wrapToolExecute`).
- Gating seam: `src/tools/approval.ts:14` (`GATED_BUILTINS`), `:23`
  (`READ_ONLY_TOOLS`), `:34` (`EDITING_TOOLS`).
- Composition roots: `src/session/session.ts:176-183` (provider registration), `:241`
  (`builtinProviders`); `src/chat/engine.ts:216` (`ports` in `buildRunStream`).
- Panel rows that appear once the providers are listed:
  `src/ui/panels/approvals.tsx:22`.

## Goal

Give the model a bounded, gated CRUD surface over vault skills and custom user
tools by adding two optional admin ports and two builtin tool providers, wired
into both port-assembly sites and classified by the existing approval engine.

## Requirements

- `src/tools/types.ts` gains:
  ```ts
  export interface SkillDraft {
    id: string
    name: string
    description: string
    instructions: string
    allowedTools: string[]
  }
  export interface SkillAdminEntry extends SkillDraft {
    source: 'vault' | 'workspace'
    enabled: boolean
  }
  export interface SkillAdminPort {
    list(): SkillAdminEntry[]
    get(id: string, source: 'vault' | 'workspace'): SkillAdminEntry | undefined
    /** True when the id exists under any source. */
    exists(id: string): boolean
    create(draft: SkillDraft, options?: { enabled?: boolean }): Promise<SkillAdminEntry>
    update(
      ref: { id: string; source: 'vault' | 'workspace' },
      patch: Partial<SkillDraft>,
      options?: { enabled?: boolean },
    ): Promise<SkillAdminEntry>
    remove(ref: { id: string; source: 'vault' | 'workspace' }): Promise<void>
  }
  export interface ToolAdminEntry {
    name: string
    kind: ToolDefinition['kind']
    description: string
    enabled: boolean
    summary: string
  }
  export interface ToolAdminPort {
    list(): ToolAdminEntry[]
    get(name: string): ToolDefinition | undefined
    /** True when a provider or a user tool owns the name. */
    hasTool(name: string): boolean
    create(definition: ToolDefinition): Promise<ToolAdminEntry>
    /** Replaces the tool named `from`; renames when `definition.name !== from`. */
    update(from: string, definition: ToolDefinition): Promise<ToolAdminEntry>
    remove(name: string): Promise<void>
  }
  ```
  `ToolRuntimePorts` gains optional `skillAdmin?: SkillAdminPort` and
  `toolAdmin?: ToolAdminPort`. Both are optional, so every existing ports object
  still typechecks.
  <!-- Updated: Red Team Session 1 - ports expose exists/hasTool for collision detection -->
- Create `src/tools/admin-ports.ts` exporting
  `createAdminPorts(registries: { skillRegistry: SkillRegistry; toolRegistry: ToolRegistry }): { skillAdmin: SkillAdminPort; toolAdmin: ToolAdminPort }`,
  plus the two individual factories `createSkillAdminPort(registry)` and
  `createToolAdminPort(registry, store)` for tests. Persistence uses the registry's
  own store:
  - `SkillRegistry` persists internally, so `createSkillAdminPort` needs no store.
  - `ToolRegistry` has no store accessor, so add `store(): ToolStore` (or a
    constructor-retained public readonly field) to `ToolRegistry`; `createToolAdminPort`
    reads it and **never defaults to the module-level `toolStore` singleton**.
  <!-- Updated: Red Team Session 1 - bind the admin port to the registry's store -->
  - `createAdminPorts` wraps every `create`/`update`/`remove` call in one promise
    chain, so a check-then-write sequence cannot interleave across concurrent calls
    from a single assistant turn.
  <!-- Updated: Red Team Session 1 - serialize admin mutations -->
  - `SkillAdminPort.list` maps `registry.list()` with `registry.isEnabled`.
  - `SkillAdminPort.exists(id)` is true when `registry.list()` contains the id under
    either source.
  - `SkillAdminPort.create` checks `exists(id)` first (throws on a hit), builds a
    `source: 'vault'` manifest, calls `registry.importSkill` (which saves and
    registers disabled), then enables and persists only when `options.enabled === true`.
  - `SkillAdminPort.update` reads the current entry, merges `patch`, calls
    `registry.updateSkill`, then applies `options.enabled` via `setEnabled` +
    `persistEnabled` when supplied. Throws when the target is absent.
  - `SkillAdminPort.create`/`update` with `options.enabled === true` call a new
    `SkillRegistry.reconcileEnabled(ref): Promise<boolean>` that re-reads the
    persisted policy through the enablement port and returns the durable value
    (`false` when the write was swallowed by a `VaultLockedError` or no policy
    exists), then returns the entry with that reconciled `enabled`.
    <!-- Updated: Validation Session 1 - reconcile enabled against the persisted policy -->
  - `SkillAdminPort.remove` calls `registry.removeSkill`.
  - `ToolAdminPort.create` checks `hasTool(name)` first (throws on a hit), then
    `await store.save(definition)`, then `registry.registerUserTool(definition)`. If
    the registry rejects after a successful save, the port rolls the row back with
    `store.remove(name)` before rethrowing — the panel's
    `save`-then-`registerUserTool` rollback at `src/ui/panels/tools.tsx:397-425` is
    the precedent.
  <!-- Updated: Red Team Session 1 - validate before write; roll back a rejected row -->
  - `ToolAdminPort.update(from, definition)` reads the current definition; when
    `definition.name !== from` it validates the new name with `hasTool` first
    (rejecting a builtin or a different user tool), then `store.save(definition)`,
    `store.remove(from)`, `registry.removeUserTool(from)`, and
    `registry.registerUserTool(definition)`. Any throw after the first write rolls
    back both the new row and the original entry. A same-name update merges over the
    current definition, saves, then `registry.replaceUserTool` (rollback on throw).
    <!-- Updated: Validation Session 1 - rename via `from`, with rollback -->
  - `ToolAdminPort.remove` calls `store.remove(name)` then
    `registry.removeUserTool(name)`.
  - `summaryOf(definition)` is a small private helper in the factory that reproduces
    the panel's exact output (`src/ui/panels/tools.tsx:161-168`): `METHOD url` for
    http, `sandbox · {timeoutMs} ms` for sandbox-js (or `sandbox` when no timeout).
  - No `summaryOf` member is exposed on the port; the port's entries carry the
    computed `summary`.
  <!-- Updated: Red Team Session 1 - drop the phantom port member; pin summary to the panel string -->
- `src/tools/registry.ts` gains three additive members:
  - `hasTool(name: string): boolean` — true when a provider or a user tool owns the
    name.
  - `store(): ToolStore` — returns the constructor-injected store.
  - `replaceUserTool(definition: ToolDefinition): void` — throws `ToolNotFoundError`
    when the name is absent; rejects only when the name belongs to a provider or to a
    *different* user entry; otherwise validates and overwrites in place. It must not
    reuse `registerUserTool`'s blanket conflict check.
  <!-- Updated: Red Team Session 1 - replaceUserTool must permit the tool's own name -->
- Create `src/tools/builtin/skill-management.ts` exporting
  `createSkillManagementProvider()` with
  `NAMES = ['list_skills', 'create_skill', 'update_skill', 'delete_skill']`.
  `isAvailable(ports)` is `ports.skillAdmin !== undefined`.
  - `list_skills({ source? })` returns the entries, optionally filtered.
  - `create_skill({ id, name, description?, instructions, allowedTools?, enabled? })`
    validates the draft with `isSkillManifest` on a `source: 'vault'` object and an
    id pattern (`/^[a-z0-9][a-z0-9._-]{0,63}$/i`), then returns `toolFail('conflict')`
    when `ports.skillAdmin.exists(id)` (any source) or `toolOk(entry)` on success.
    `enabled` defaults to `false`.
  - `update_skill({ id, source? = 'vault', ...patch })` returns
    `toolFail('permission_denied')` for `source: 'workspace'`, `toolFail('not_found')`
    for an absent target, `toolFail('invalid_input')` when no patch field is
    supplied, else `toolOk(updated)`.
  - `delete_skill({ id, source? = 'vault' })` mirrors the update guards and removes.
- Create `src/tools/builtin/tool-management.ts` exporting
  `createToolManagementProvider()` with
  `NAMES = ['list_user_tools', 'create_tool', 'update_tool', 'delete_tool']`.
  `isAvailable(ports)` is `ports.toolAdmin !== undefined`.
  - `list_user_tools` returns entries.
  - `create_tool` accepts a definition whose `enabled` is **optional**; the provider
    fills `enabled: false` before validating so a model call that omits it still
    validates (the plan's default-disabled contract). It validates with
    `isToolDefinition`, `validateToolName`, `assertPlainSchema`, and (for http)
    `assertHttpDefinition`, returns `toolFail('conflict', ...)` when
    `ports.toolAdmin.hasTool(name)` (builtin or user), else `toolOk(entry)`.
    <!-- Updated: Red Team Session 1 - isToolDefinition requires enabled:boolean; default it first -->
  - `update_tool({ from, name?, ...patch })` requires an existing tool named
    `from`; `name` defaults to `from` and, when different, renames the tool. It
    merges the remaining patch over the current definition (kind immutable),
    validates the merged definition, and returns `toolOk(entry)`.
    <!-- Updated: Validation Session 1 - rename via `from` -->
  - `delete_tool({ name })` returns `toolFail('not_found')` when absent, else
    `toolOk({ name, deleted: true })`.
- `src/tools/approval.ts` changes, applied explicitly to both sets:
  - `GATED_BUILTINS` gains `create_skill`, `update_skill`, `delete_skill`,
    `create_tool`, `update_tool`, `delete_tool`.
  - `EDITING_TOOLS` gains the same six names (>the spread only carries
    `READ_ONLY_TOOLS`).
  - `READ_ONLY_TOOLS` gains `list_skills`, `list_user_tools`.
  <!-- Updated: Red Team Session 1 - add mutation tools to EDITING_TOOLS explicitly -->
- `src/session/session.ts`:
  - registers both providers in the `!options.toolRegistry` block (`:176-183`);
  - appends `createSkillManagementProvider()` and `createToolManagementProvider()`
    to the hardcoded provider array returned by `builtinProviders` (`:252-259`) —
    without this the Tools panel never lists them and the phase's own test fails;
  - builds `skillAdmin` / `toolAdmin` in the `ports` object (`:243-251`) via
    `createAdminPorts`.
  <!-- Updated: Red Team Session 1 - builtinProviders returns a hardcoded array; append the providers -->
- `src/chat/engine.ts` adds the same two ports to the `ports` object in
  `buildRunStream` (`:216`) via `createAdminPorts`, using `deps.skillRegistry` and
  `deps.toolRegistry`. `PipelineDeps` already carries both registries, so no deps
  change is needed.

## Architecture

```
model turn
  → buildRunStream (engine.ts:216)
      ports = { workspace, codeRunner, sandbox, mode, skills, plan,
                ...createAdminPorts({ skillRegistry, toolRegistry }) }   // ← new
      toolSet = toolRegistry.buildToolSet(requested, ports)
  → model calls create_skill / create_tool / ...
  → provider validates (collision check first), calls port
      createAdminPorts serializes:
        SkillAdminPort → SkillRegistry.importSkill/updateSkill/removeSkill
                         → skillStore (encrypted)  + enablement policy
        ToolAdminPort  → toolStore (the registry's store) + register/replace/remove
  → toolOk(entry) | toolFail(code, message)
```

`builtinProviders` (`src/session/session.ts:241`) builds the same two ports from
the same registries and appends the same providers, so the Tools panel's
availability matches a run. Because the providers are appended, `ApprovalsPanel`
(`src/ui/panels/approvals.tsx:22`) automatically gains the six gated rows; that is
intended.

**Trust boundary.** `create_*` defaults `enabled` to `false`: a freshly minted
skill or tool persists inert. The mutation is visible to the user before it can
affect model behavior, and the user enables it in the panel. A model may pass
`enabled: true`; that is the accepted `write_file`-parity decision from the
brainstorm, and it is not an approval barrier in `god` or after an `allow-always`
(recorded in plan.md).

**Failure contract.** Providers never let `ToolNameConflictError`,
`ToolNotFoundError`, or a validation error escape as a throw; they return the
matching envelope code. Only `ToolRuntimeUnavailableError` and unexpected errors
throw, which `wrapToolExecute` maps to `runtime_error`.

## Files to Create / Modify

Create:

- `src/tools/admin-ports.ts` — `createAdminPorts`, `createSkillAdminPort`,
  `createToolAdminPort`.
- `src/tools/admin-ports.test.ts`
- `src/tools/builtin/skill-management.ts`
- `src/tools/builtin/skill-management.test.ts`
- `src/tools/builtin/tool-management.ts`
- `src/tools/builtin/tool-management.test.ts`

Modify:

- `src/tools/types.ts` — admin port types and two optional `ToolRuntimePorts`
  members.
- `src/tools/registry.ts` — `hasTool`, `store`, `replaceUserTool`.
- `src/tools/registry.test.ts` — cases for the three new members.
- `src/skills/registry.ts` — `reconcileEnabled` (Phase 2 adds the observer methods
  to the same file afterward).
- `src/skills/registry.test.ts` — `reconcileEnabled` cases.
  <!-- Updated: Validation Session 1 - reconcile enabled against the persisted policy -->
- `src/tools/approval.ts` — gating sets (both `GATED_BUILTINS` and `EDITING_TOOLS`).
- `src/tools/approval.test.ts` — asserted sets.
- `src/session/session.ts` — register providers; append to `builtinProviders`; build
  admin ports.
- `src/session/session.test.ts` — both providers report available; the six gated
  names appear once filtered by `isGatedTool`.
- `src/chat/engine.ts` — build admin ports in `buildRunStream`.

Do not modify: `src/ui/**` (the ApprovalsPanel rows are automatic),
`src/skills/store.ts`, `src/skills/enablement.ts`, `src/tools/store.ts`,
`src/workspace/**`, `src/sandbox/**`, `src/vault/**`.
<!-- Updated: Validation Session 1 - src/skills/registry.ts is now modified for reconcileEnabled -->

## Test Plan

Unit — `src/tools/admin-ports.test.ts`

- `create` then `list` round-trips a skill through a real `SkillRegistry` with an
  in-memory `SkillStore`; `enabled` is false by default.
- `create` with `{ enabled: true }` and a fake enablement port records the ref.
- `create` with an id that exists only under `workspace` throws (via `exists`).
- `update` merges a patch and preserves unsupplied fields.
- `remove` deletes the skill and its enablement.
- Tool `create` saves then registers; a duplicate provider/user name is rejected
  before any store write (spy asserts `save` not called).
- Tool `create` rolls the row back when `registerUserTool` rejects after a save.
- Tool `update` overwrites in place using the tool's own name; `delete` removes
  store row and registry entry.
- Tool `update(from, definition)` with a new `definition.name` renames: the old row
  and entry are gone, the new name resolves; a forced failure after the first write
  rolls both back.
- Skill `create` with `{ enabled: true }` and an enablement port whose `save` throws
  `VaultLockedError` returns `enabled: false` (reconciled), and the in-memory
  registry is also disabled.
- Two concurrent `create` calls with the same name: one succeeds, the other throws.

Unit — `src/tools/builtin/skill-management.test.ts`

- `isAvailable` is false without `skillAdmin`.
- `list_skills` returns entries and honors the `source` filter.
- `create_skill` on a new id returns `toolOk` with `enabled: false`.
- `create_skill` duplicate id returns `{ ok: false, code: 'conflict' }` for both a
  vault id and a workspace-only id.
- `create_skill` with an empty id or missing instructions returns `invalid_input`.
- `update_skill` merges and returns `not_found` / `permission_denied` / `invalid_input`.
- `delete_skill` returns `permission_denied` for workspace, `not_found` for absent,
  `ok` for vault.

Unit — `src/tools/builtin/tool-management.test.ts`

- `isAvailable` is false without `toolAdmin`.
- `create_tool` accepts an http definition with **no** `enabled` field and returns it
  disabled; a bad URL or schema returns `invalid_input`.
- `create_tool` rejects a builtin name and an existing user-tool name with `conflict`.
- `update_tool` merges a patch and preserves kind.
- `update_tool({ from, name })` renames and returns the new entry; renaming onto a
  builtin/user name returns `conflict`.
- `delete_tool` returns `not_found` / `ok`.

Unit — `src/tools/approval.test.ts`

- `isGatedTool` is true for the six mutation names and false for the two list names.
- `modeCeiling('read_only')` contains both list names and neither mutation name.
- `resolveApprovalStatus('editing', { tools: { create_skill: 'allow' } }, 'create_skill')`
  is `approved`; with an empty policy it is `user-approval`.
- `resolveApprovalStatus('god', {}, 'create_skill')` is `approved`, and
  `createToolApproval('god', ..., ['create_skill'])` keeps the entry with
  `approved` (not absent).

Unit — `src/session/session.test.ts`

- `builtinProviders()` includes `list_skills`, `create_skill`, `list_user_tools`,
  `create_tool`, all available.
- Filtering `builtinProviders()` through `isGatedTool` yields the six mutation names
  (what `ApprovalsPanel` renders).

Regression

- `src/tools/registry.test.ts`, `src/chat/harness-e2e.test.ts`,
  `src/chat/engine.test.ts`, `src/chat/transport.test.ts`, and
  `src/chat/approval.test.ts` pass unchanged (the `god`/`change_mode` expectations
  at `src/chat/approval.test.ts:41-46` must not change).

## Implementation Steps

1. Add the port types and the two optional `ToolRuntimePorts` members to
   `src/tools/types.ts`.
2. Add `hasTool`, `store`, and `replaceUserTool` to `src/tools/registry.ts`;
   extend `src/tools/registry.test.ts`.
3. Write `src/tools/admin-ports.ts` against `SkillRegistry`, `ToolRegistry`, and the
   registry's store; include the serialization chain, pre-write collision checks,
   rollback, tool rename, and skill enablement reconciliation. Write
   `admin-ports.test.ts` with in-memory stores.
4. Write `src/tools/builtin/skill-management.ts` and its test with a fake
   `SkillAdminPort`.
5. Write `src/tools/builtin/tool-management.ts` and its test with a fake
   `ToolAdminPort`.
6. Extend `src/tools/approval.ts` (both sets) and `src/tools/approval.test.ts`.
7. Register both providers in `src/session/session.ts`, append them to
   `builtinProviders`' array, and build the admin ports; add the `session.test.ts`
   availability and gated-name cases.
8. Build the admin ports in `src/chat/engine.ts` `buildRunStream`.
9. Run `pnpm test`, then `pnpm lint` and `pnpm build`.

## Todo

- [x] Admin port types (`exists`, `hasTool`) + optional `ToolRuntimePorts` members
- [x] `hasTool`, `store`, `replaceUserTool` on `ToolRegistry`
- [x] `src/tools/admin-ports.ts` with serialization, pre-write checks, rollback,
      tool rename, and enablement reconcile + tests
- [x] `src/skills/registry.ts` `reconcileEnabled` + tests
- [x] `src/tools/builtin/skill-management.ts` + tests
- [x] `src/tools/builtin/tool-management.ts` (optional `enabled`, `from` rename) + tests
- [x] Gating sets (both `GATED_BUILTINS` and `EDITING_TOOLS`) + approval tests
- [x] Session wiring (register + append to `builtinProviders`) + engine ports
- [x] `pnpm test`, `pnpm lint`, `pnpm build` green

## Success Criteria

- [x] The eight named tools exist and each provider reports available when its
      admin port is present.
- [x] Created skills and tools default to disabled and persist through the vault
      stores; a requested `enabled: true` reports the durable, reconciled state.
- [x] `update_tool` renames via `from` and rolls back a partial failure.
- [x] A duplicate id (vault or workspace) and a builtin/user tool name return
      `conflict` and write no store row, proven by tests.
- [x] Workspace skills cannot be updated or deleted through a tool.
- [x] Every expected failure returns the documented envelope code, proven by tests.
- [x] The six mutation tools are in both `GATED_BUILTINS` and `EDITING_TOOLS`; the
      two list tools are read-only, proven by `approval.test.ts`.
- [x] `builtinProviders()` lists the management tools and `ApprovalsPanel`'s
      predicate yields the six gated names.
- [x] `pnpm test`, `pnpm lint`, and `pnpm build` pass.

## Risk Assessment

| Risk | Likelihood × impact | Mitigation |
|------|---------------------|------------|
| Admin port write path bypasses the registry's validation | Medium × High | The factory calls registry methods that already validate; tool `create`/`update` validate before saving. |
| Port assembly drifts between panel and run | Medium × Low | One `createAdminPorts` factory with a specified signature; both call sites use it. |
| A duplicate skill id silently overwrites | Medium × High | `exists(id)` checks both sources before `importSkill`; the mutation chain serializes concurrent calls; tests cover vault and workspace collisions. |
| A builtin-name tool create writes an orphan row | Medium × High | `hasTool(name)` is checked before `store.save`; rollback removes a just-saved row if the registry rejects; tests assert both. |
| Created `enabled: true` persists active without a user enable step | Medium × High | Accepted `write_file`-parity decision; default is false; residual `god`/`allow-always` risk recorded in plan.md. |
| Tool description/instructions carry injection | Medium × Medium | Accepted residual risk recorded in plan.md; bodies only reach the model via gated calls or user-enabled definitions. |
| Management tools are excluded by a narrowing skill | Medium × Low | Documented limitation; no exemption. A test asserts the exclusion is honored, not a bug. |

**Rollback.** Revert the phase's files. The new ports and tools disappear, the
gating sets return to their previous contents, and no vault record changes format;
created artifacts remain readable by the untouched stores.

## Security Considerations

- Mutations are gated by the existing approval engine; no new bypass. The `god`-mode
  auto-approve and `allow-always` paths are called out explicitly rather than
  claimed safe.
- Skill/tool definitions persist encrypted in the existing vault stores; no
  plaintext.
- Workspace-sourced content stays immutable and untrusted.
- Collision checks run before any persistent write, so a rejected create cannot
  leave a hidden row.
- The model cannot alter approval policy, modes, or enablement policy; it can only
  set a skill's or tool's own `enabled` field.

## Next Steps

Phase 2 adds registry change notification, including the `updateSkill` path, so the
Skills and Tools panels reflect these mutations live. Phase 3 runs the end-to-end
verification.
