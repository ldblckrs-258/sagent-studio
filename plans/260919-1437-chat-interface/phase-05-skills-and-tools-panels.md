---
phase: 5
title: "Skills and Tools Panels"
status: implemented (browser gate pending)
priority: P2
effort: "8h"
dependencies: [1, 4]
---

# Phase 5: Skills and Tools Panels

## Goal

Add the skills panel (list vault and workspace skills, toggle global enablement,
import a `SKILL.md`, edit, remove) and the tools panel (builtin availability,
user-tool CRUD for `http` and `sandbox-js`, persisted enable/disable).

## Context

- `SkillRegistry` (`src/skills/registry.ts:17`) exposes `list` (`:39`), `get`
  (`:35`), `isEnabled` (`:43`), `setEnabled` (`:47-51`), `resolve` (`:53`),
  `importSkill` (`:98-104`), `updateSkill` (`:106-114`), `removeSkill` (`:116-121`),
  `loadWorkspaceSkills` (`:123-129`), and `hydrate` (`:131-135`).
- Skill enablement is **in-memory only**: `enabled` is a private `Set<string>`
  (`src/skills/registry.ts:19`), and `hydrate` re-enables every vault skill
  (`:131-135`). `SkillManifest` has no `enabled` field
  (`src/skills/schema.ts:3-11`).
- `parseSkillMarkdown(markdown, fallbackName)` returns
  `{ name, description, instructions, allowedTools }` and throws
  `SkillParseError` for invalid YAML or a non-mapping frontmatter
  (`src/skills/parser.ts:29-64`).
- Workspace skills are discovered under `WORKSPACE_SKILLS_ROOT = '.agents/skills'`
  by `createWorkspaceSkillSource(workspace)` (`src/skills/workspace-source.ts:8`,
  `:47-54`); a malformed `SKILL.md` is skipped rather than aborting the walk
  (`:38-42`).
- `ToolRegistry` (`src/tools/registry.ts:30`) exposes `hydrate` (`:39-41`),
  `registerProvider` (`:43-51`), `registerUserTool` (`:53-63`), `setEnabled`
  (`:65-69`), `list` (`:71-73`), `availableNames` (`:75-84`), and `buildToolSet`
  (`:86-103`). **There is no remove or replace method**; `registerUserTool`
  throws `ToolNameConflictError` when the name already exists (`:59-61`).
- **`setEnabled` does not persist** (`src/tools/registry.ts:65-69`). The enabled
  flag lives on the definition (`src/tools/types.ts:35`, `:53`), and `hydrate`
  re-reads it from the store (`src/tools/registry.ts:39-41`), so a toggle must
  also call `toolStore.save`.
- Validators: `validateToolName` and `assertPlainSchema` are exported
  (`src/tools/types.ts:114`, `:124`); `assertHttpDefinition` is private in
  `src/tools/store.ts:9-46` and must be exported for pre-save field validation.
  `saveTool` re-validates through `assertDefinition` (`src/tools/store.ts:48-63`,
  `:85-92`).
- Builtin providers: `workspaceToolProvider.names` is
  `['list_dir','read_file','write_file','make_dir','remove']`
  (`src/tools/builtin/workspace.ts:5`, `:23`) with
  `isAvailable: (ports) => ports.workspace !== undefined` (`:25`);
  `createCodeToolProvider(runners).names` is `['run_js','run_python']` with
  `isAvailable: () => true` (`src/tools/builtin/code.ts:6`, `:29-34`).
- `Settings` currently has no skills slice (`src/vault/settings.ts:30-37`).
  `deepMerge` tolerates additive fields without a version bump (`:76-91`);
  `migrate` merges persisted data over `defaultSettings()` (`:93-106`).
- House form patterns are in `src/ui/primitives.tsx`; `Row`, `Field`, `Button`,
  and `Input` are the units.

## Requirements

Functional:

- `src/ui/panels/skills.tsx` lists vault and workspace skills from
  `skillRegistry.list()` after `loadWorkspaceSkills(createWorkspaceSkillSource(workspace))`,
  with a global enable toggle per skill, an import action, an edit form, and a
  remove action.
- Import reads a user-selected `SKILL.md` as text, parses it with
  `parseSkillMarkdown(text, fallbackName)`, and registers it as an **untrusted**
  import: it is enabled only after an explicit user confirmation, and until then
  it is registered disabled and is not eligible for the trusted
  `composeSystemPrompt` block (red-team finding: imported content is untrusted).
  A `SkillParseError` renders as a message and is not thrown; one bad file must
  not break the list.
- Edit calls `skillRegistry.updateSkill`; remove calls
  `skillRegistry.removeSkill` after confirmation. Removal of a skill referenced by
  a thread config is allowed and the next run simply resolves fewer skills
  (`SkillRegistry.resolve` skips unregistered refs, `src/skills/registry.ts:59-61`).
- Global skill enablement persists in `Settings.skills?: { enabled?: PersistedSkillRef[] }`,
  an optional additive slice. `PersistedSkillRef` is declared structurally inside
  `src/vault/settings.ts` (`{ id: string; source: 'vault' | 'workspace' }`) so the
  vault layer imports nothing from `src/chat` — the same shape as `SkillRef` but
  with no cross-layer dependency (red-team finding: import direction). The
  registry maps between the two by shape.
- `SkillRegistry` gains an optional enablement port. Load applies the policy to
  both vault and workspace skills; save is async and returns a result so a
  failure can be surfaced. `setEnabled` stays synchronous for callers and the
  port exposes a separate awaiting `persist()`/result path; the panel awaits the
  persist and renders the error when it fails, rather than claiming success
  (red-team finding: no failure channel).
- `hydrate()` loads the policy once and enables exactly the persisted refs; it
  falls back to enabling all vault skills when the port returns `null`. The
  `null` case is the legacy/no-policy path so an existing vault does not lose its
  skills on upgrade.
- `loadWorkspaceSkills()` also applies the persisted policy when it registers
  workspace skills, instead of hardcoding `{ enabled: false }`
  (`src/skills/registry.ts:126`). Without this, a workspace-skill toggle reverts on
  every reload (red-team finding 11).
- `src/ui/panels/tools.tsx` lists builtin providers read-only with their names and
  `isAvailable(ports)` result, and lists user tools with an enable toggle.
- Toggling a user tool calls `ToolRegistry.setEnabled` **and**
  `toolStore.save({ ...definition, enabled })`, reverting the registry flag if the
  save fails.
- The tools panel creates, edits, and deletes `http` and `sandbox-js` definitions.
  Validation runs `validateToolName`, `assertPlainSchema`, and (for `http`)
  `assertHttpDefinition` before save so errors map to fields; `toolStore.save` is
  still the final gate.
- The name is checked against the registry's provider and user-tool pool **before**
  any persist. `saveTool` does not check provider collisions
  (`src/tools/store.ts:85-92`) and `registerUserTool` throws afterwards, so
  saving first would leave a conflicting row that makes `hydrate()` throw on every
  unlock (red-team finding 15). If a post-save registration still fails, the
  persisted row is deleted before the error is surfaced.
- `ToolRegistry` gains `removeUserTool(name)` because no remove or replace exists.
  Editing with a name change removes the old definition from the store and the
  registry after a successful save.

Non-functional:

- New app files use house style (relative imports, single quotes, no semicolons).
- Skills and tools panels render `settings === null` as a locked state.
- A malformed workspace `SKILL.md` is reported per-row and never aborts the list.
- `parseSkillMarkdown` is the only skill-parsing path; the panel does not
  re-implement frontmatter parsing.
- No new dependency is added; file import uses a plain `<input type="file">` and
  `File.text()`.
- Management is single-record only: no bulk JSON export or import (user decision,
  Validation Session 1).

## Architecture

```
src/vault/settings.ts      + skills?: { enabled?: PersistedSkillRef[] } (local
                             structural type; no import from src/chat)
src/skills/registry.ts     + optional SkillEnablementPort; hydrate,
                             loadWorkspaceSkills, setEnabled, importSkill,
                             removeSkill consult it
src/tools/registry.ts      + removeUserTool(name)
src/tools/store.ts         export assertHttpDefinition for pre-save validation
src/session/session.ts     construct SkillRegistry with the vault-backed port;
                             expose builtin provider descriptors
src/ui/panels/skills.tsx   list / toggle / import / edit / remove
src/ui/panels/tools.tsx    builtin availability / user tool CRUD / toggle
src/ui/shell.tsx           mounts both panels
```

Enablement port:

```ts
export interface SkillEnablementPort {
  /** Returns null when no policy has ever been persisted. */
  load(): Promise<SkillRef[] | null>
  save(enabled: readonly SkillRef[]): Promise<void>
}
```

`snapshotEnabled()` reconstructs `SkillRef[]` by iterating `this.skills` and
keeping entries whose `skillKey(skillRefOf(manifest))` is in the in-memory set,
so persistence never stores a raw key string.

Persistence choice: `skills` is declared **optional** and is deliberately not
added to `defaultSettings()`. If it were added as `{ enabled: [] }`, `migrate`'s
`deepMerge(defaultSettings(), data)` would stamp an empty policy onto every
existing vault and silently disable every skill on the next unlock. Keeping the
field absent means "no policy, enable all", which preserves current behaviour;
once a user toggles anything, the port writes a concrete list. This is the
smallest safe mechanism and needs no version bump or migration change.

Tool toggle flow:

```
toggle(name, enabled) -> registry.setEnabled(name, enabled)   // in-memory
                      -> await toolStore.save({ ...definition, enabled })
                      -> on failure: registry.setEnabled(name, !enabled) + error
```

## Files to Create / Modify

- Create: `src/ui/panels/skills.tsx`
- Create: `src/ui/panels/tools.tsx`
- Create: `src/skills/enablement.ts` (port type + vault-backed implementation)
- Create: `src/skills/enablement.test.ts`
- Modify: `src/vault/settings.ts` (optional `skills` slice)
- Modify: `src/skills/registry.ts` (construct with optional port; consult it in
  `hydrate`, `setEnabled`, `importSkill`, `removeSkill`)
- Modify: `src/tools/registry.ts` (add `removeUserTool`)
- Modify: `src/tools/store.ts` (export `assertHttpDefinition`)
- Modify: `src/session/session.ts` (construct the skills port; expose builtin
  provider descriptors with `isAvailable`)
- Modify: `src/ui/shell.tsx` (mount both panels)
- Extend: `src/tools/registry.test.ts` and `src/skills/registry.test.ts`

## Implementation Steps

1. Add the optional slice to `src/vault/settings.ts`:
   `skills?: { enabled?: PersistedSkillRef[] }` on `Settings`, where
   `PersistedSkillRef = { id: string; source: 'vault' | 'workspace' }` is declared
   locally in that file so the vault layer imports nothing from `src/chat`
   (red-team finding: import direction). Do not touch `defaultSettings()` or
   `migrate`.
2. Add `src/skills/enablement.ts` with the `SkillEnablementPort` type —
   `load(): Promise<SkillRef[] | null>` and
   `save(enabled: readonly SkillRef[]): Promise<void>` — plus
   `createVaultSkillEnablement()` over
   `useVaultStore.getState().settings?.skills?.enabled ?? null` and
   `useVaultStore.getState().update({ skills: { enabled: [...] } })`. Swallow a
   `VaultLockedError` on save the way `ProvidersPanel`'s debounced writes do
   (`src/settings/ProvidersPanel.tsx:228-232`) so a lock race is benign, and
   return a rejected result for other failures so the caller can render them.
3. Modify `src/skills/registry.ts`: add an optional second constructor argument
   `enablement?: SkillEnablementPort` and a `snapshotEnabled()` helper. Change
   `hydrate()` to load the policy once: `null` means register each vault skill
   with `enabled: true` (current behaviour); a list means register with `enabled`
   iff its ref is in the list. Change `loadWorkspaceSkills()` to apply the same
   policy after registering, so a persisted workspace ref is honoured on reload
   (red-team finding 11). Persist after `setEnabled`, `importSkill`, and
   `removeSkill` when a port exists, and expose the persist promise to the panel
   so a failure is visible instead of silent.
4. Extend `src/skills/registry.test.ts` with an in-memory fake port: legacy
   `null` enables all; a persisted list enables exactly those refs, including a
   workspace ref applied through `loadWorkspaceSkills`; toggling writes the new
   list; import adds the new ref; remove drops it; a save failure surfaces and
   does not corrupt the in-memory set.
5. Add `src/skills/enablement.test.ts` using `fake-indexeddb` and the vault store
   fixture: save then load round-trips refs; absent slice loads `null`; a locked
   store fails closed without throwing into the panel.
6. Modify `src/tools/registry.ts` to add `removeUserTool(name: string): void`
   that throws `ToolNotFoundError` when absent and deletes from `userTools`.
7. Modify `src/tools/store.ts` to export `assertHttpDefinition` unchanged.
8. Extend `src/session/session.ts` to construct the `SkillRegistry` with
   `createVaultSkillEnablement()` and to expose
   `builtinProviders(): Array<{ name: string; available: boolean }>` derived from
   `workspaceToolProvider.names` and the code provider's names evaluated against
   the current `{ workspace, codeRunner }` ports.
9. Add `src/ui/panels/skills.tsx`: load vault skills from the registry and
   workspace skills via `loadWorkspaceSkills(createWorkspaceSkillSource(workspace))`
   when a workspace exists; render one row per skill with source, name,
   description, an enable toggle, Edit, and Remove; an import button using a
   hidden `<input type="file" accept=".md,text/markdown">`. Imported files are
   registered disabled and marked untrusted; enabling one requires an explicit
   confirmation that states the imported instructions will influence the model
   (red-team finding: imported content is untrusted). Show a per-row parse error
   when `parseSkillMarkdown` throws and keep the rest of the list intact. The edit
   form edits name, description, instructions, and `allowed-tools`.
10. Add `src/ui/panels/tools.tsx`: a read-only builtin section (name +
    available/unavailable), and a user-tool section with an enable toggle and
    create/edit/delete. The create/edit form switches on `kind`: for `http`,
    fields for method, url, headers (JSON), body, `allowedOrigins`, and
    `timeoutMs`; for `sandbox-js`, fields for source and `timeoutMs`. The
    `inputSchema` field is a JSON textarea validated with `assertPlainSchema`.
    Validate before save and render field errors.
11. Implement the save path in this order: validate; reject a name that collides
    with a builtin provider or an existing user tool **before** persisting; then
    `await toolStore.save(next)`; then `registry.removeUserTool(oldName)`
    (when renamed) and `registry.registerUserTool(next)`. If `registerUserTool`
    still throws after the save, delete the persisted row
    (`toolStore.remove(next.name)`) and re-register the previous definition before
    surfacing the error, so a bad name can never poison the next `hydrate()`
    (red-team finding 15). Revert the enable flag in the registry if the toggle
    save fails.
12. Mount `Skills` and `Tools` in the shell rail in `src/ui/shell.tsx`.
13. `pnpm test`, `pnpm lint`, `pnpm build`.
14. Browser gate: import a valid and an invalid `SKILL.md`; edit a skill; toggle
    a skill, reload, and confirm the toggle persists; toggle a user tool, reload,
    and confirm; create an `http` tool with a malformed schema and confirm the
    field error; create a `sandbox-js` tool; delete both. Record in the journal.

## Todo

- [ ] optional `Settings.skills` slice with a local structural ref, no version bump
- [ ] `SkillEnablementPort` + vault-backed implementation + tests
- [ ] `SkillRegistry` consults the port on hydrate/loadWorkspaceSkills/toggle/import/remove
- [ ] imported `SKILL.md` registered disabled + explicit untrusted-enable confirm
- [ ] `ToolRegistry.removeUserTool`
- [ ] `assertHttpDefinition` exported for pre-save validation
- [ ] tool name collision rejected before persist; failed registration rolls back the row
- [ ] session constructs the skills port + builtin provider descriptors
- [ ] `src/ui/panels/skills.tsx` (list/toggle/import/edit/remove, per-row errors)
- [ ] `src/ui/panels/tools.tsx` (builtin availability, CRUD, save-on-toggle)
- [ ] shell mounts both panels
- [ ] browser gate recorded
- [ ] lint / build / full test green

## Verification

- `pnpm test -- src/skills src/tools` passes, including enablement round-trip,
  save-on-toggle, and remove/replace.
- `pnpm test` full suite green (assert; do not encode a count).
- `pnpm lint` and `pnpm build` clean.
- Browser gate recorded in the journal: import valid + invalid skill, toggle
  persistence across reload, malformed tool schema rejection, and tool delete.
- Grep gate: the tools panel calls `toolStore.save` on every toggle path; no
  toggle mutates the registry without persisting.

## Success Criteria

- [ ] Acceptance criterion 8: vault and workspace skills list, toggle, import,
      edit, and remove; a malformed file is a row error, not a crashed panel.
- [ ] Acceptance criterion 9: builtin availability and user-tool CRUD with
      schema validation; enable/disable survives reload.
- [ ] A vault with no `skills` key keeps every skill enabled after unlock.
- [ ] A workspace-skill toggle survives reload, not only a vault-skill toggle.
- [ ] An imported `SKILL.md` is disabled and untrusted until the user explicitly
      enables it, and enabling requires a confirmation.
- [ ] A tool named like a builtin is rejected before persisting; no rejected save
      can break the next `hydrate()`.
- [ ] Toggling never leaves the registry and the encrypted store out of sync.
- [ ] No new dependency is added for file import or forms.

## Risk Assessment

| Risk | Signal it broke | Pre-decided response |
|------|-----------------|----------------------|
| Adding `skills` to `defaultSettings()` disables existing skills | Skills vanish on first unlock after upgrade | Keep the field optional and absent by default; `null` policy means enable-all; unit-test the legacy path. |
| `ToolRegistry.setEnabled` persists nothing | Toggle reverts after reload | Always pair with `toolStore.save`; browser gate reloads after a toggle. |
| No registry remove method | Deleted tool still callable until reload | Add `removeUserTool`; test delete plus `availableNames`. |
| Renaming a tool collides or half-applies | Duplicate or missing tool | Validate first, save new before removing old, re-register the old definition on failure. |
| A workspace `SKILL.md` is malformed | Whole list fails to load | `createWorkspaceSkillSource` already skips malformed files (`src/skills/workspace-source.ts:38-42`); surface a per-row note and continue. |
| A skill is removed while a thread config references it | Run resolves fewer skills silently | Accept: `resolve` skips unknown refs (`src/skills/registry.ts:59-61`); the Thread tab in Phase 4 shows the missing reference. |
| Save port races vault lock | Unhandled rejection | Swallow `VaultLockedError` like the existing debounced provider writes. |

## Security Considerations

- A workspace-sourced `SKILL.md` is untrusted; it is registered with
  `source: 'workspace'` and stays disabled by default
  (`src/skills/registry.ts:126`), and `composeSystemPrompt` keeps untrusted text in
  a labeled block (predecessor Phase 1 contract).
- Imported files are parsed, never executed; `allowed-tools` is stored as data and
  capped against the available pool at run time
  (`src/skills/registry.ts:82-96`).
- HTTP tool definitions are validated for a URL, an `allowedOrigins` list, and
  string headers before storage (`src/tools/store.ts:9-46`); the runtime still
  enforces the host allow-list and a resolved-origin check.
- Enablement and definitions persist encrypted through the vault write queue; no
  skill or tool content is written plaintext.
- The panels render no secret and add no network call.

## Next Steps

Phase 6 adds the sandbox panel and swaps the session's runners when sandbox
settings change.
