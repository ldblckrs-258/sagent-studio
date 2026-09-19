---
phase: 4
title: "Chat Config Panel"
status: implemented (browser gate pending)
priority: P1
effort: "6h"
dependencies: [1]
---

# Phase 4: Chat Config Panel

## Goal

Add one right-rail tabbed config panel — Thread, Providers, Vault — that edits
every `ThreadConfig` field with validation, mounts the existing provider and vault
surfaces unchanged, and relocates the storage and egress notices out of the center
column.

## Context

- `ThreadConfig` is `{ providerId, modelId?, systemInstruction, params {
  temperature, topP, topK, maxOutputTokens }, maxSteps, providerOptions?,
  enabledSkills[] }` (`src/chat/types.ts:16-24`). `validateThreadConfig` enforces
  a non-empty `providerId`, ranges for `temperature` (0-2) and `topP` (0-1),
  positive integers for `topK`/`maxOutputTokens`, `maxSteps >= 4`
  (`MIN_MAX_STEPS`, `:36`), a plain-object `providerOptions`, and `SkillRef`
  shape (`:100-158`); it throws `ChatConfigError`.
- `defaultThreadConfig(providerId, modelId?)` pins `maxSteps: 6`
  (`src/chat/types.ts:38-47`).
- `ChatEngine` exposes no config update method (`src/chat/engine.ts:45-51`), and
  `persist()` is private (`:217-232`). The smallest change is to write the config
  directly: `useChatStore.setThread({ ...thread, config })` then
  `saveThread(next)` (`src/chat/persistence.ts:69-76`).
- Settings have **no global default provider** (`src/vault/settings.ts:30-37`);
  each `ProviderConfig` carries its own `models` and `defaultModel` (`:5-13`).
- `ProvidersPanel` is self-contained: it reads `useVaultStore`, validates with
  `validateProvider`, and persists through `update({ providers: list })`
  (`src/settings/ProvidersPanel.tsx:68-80`, `:301-309`), so it can be mounted in a
  tab unchanged.
- `StorageWarning` (`src/settings/StorageWarning.tsx:6`) and `DataEgressNotice`
  (`src/settings/DataEgressNotice.tsx:4`) return `null` when not applicable and
  read `useVaultStore` directly, so relocation is a mount change only.
- `idleLockMinutes` defaults to 15 (`src/vault/settings.ts:58`) and is consumed by
  `useIdleLock` in `App.tsx:18`; there is no editor UI for it yet.
- `useVaultStore.update(patch)` deep-merges and is the single settings write path
  (`src/vault/store.ts:309-320`); `DeepPartial<Settings>` accepts a partial patch
  (`src/vault/settings.ts:64-68`).
- House form patterns: `Row` with `hint` and `error` (`src/ui/primitives.tsx:68-94`),
  `Field` with a `role="alert"` error (`:38-58`), and `.label-micro` section
  eyebrows (`src/index.css:178-184`).

## Requirements

Functional:

- `src/ui/panels/chat-config.tsx` renders three tabs: Thread, Providers, Vault.
- Thread tab edits provider, model, `systemInstruction`, `params.temperature`,
  `params.topP`, `params.topK`, `params.maxOutputTokens`, `maxSteps`, a
  `providerOptions` JSON object, and per-thread enabled skills. Provider and model
  options come from `useVaultStore.settings.providers` and the selected provider's
  `models`/`defaultModel`.
- Saving validates the draft with `validateThreadConfig`; field errors render next
  to the field; an invalid draft blocks the save and never reaches the engine or
  the store.
- A valid save does `useChatStore.setThread({ ...thread, config: validated })` and
  `await saveThread(next)`.
- Providers tab mounts `ProvidersPanel` unchanged.
- Vault tab mounts `StorageWarning` and `DataEgressNotice` unchanged. No
  idle-lock editor is added: it is outside the requested chat-config scope, and a
  `0` value would switch the auto-lock control off entirely
  (`src/vault/use-idle-lock.ts:13`), so it is dropped (red-team scope finding).
- New-thread default provider is the first configured provider, deterministically;
  with no provider configured the send action is disabled and the shell shows a
  link that activates the Providers tab.
- `src/chat/config.ts` provides pure helpers: `threadConfigPatch(draft)` and
  `validateConfigDraft(draft)` returning a field-error map. It reuses
  `defaultProviderFor` defined once in `src/chat/threads.ts` (Phase 2) rather than
  defining a second copy (red-team finding: one provider rule).
- The field-error map covers every `ChatConfigError` message the validator can
  throw, including messages with no field prefix (`enabledSkills`, top-level
  config shape); unmapped messages land under a `_form` key so a blocked save
  always renders a visible error.
- The center column no longer renders `StorageWarning`/`DataEgressNotice` (Phase 1
  kept them there temporarily); they live in the Vault tab.

Non-functional:

- The panel never persists a partial or invalid config.
- The panel works when `settings` is null by rendering a locked state, because
  `useVaultStore` exposes `settings: null` whenever the vault is not unlocked
  (`src/vault/store.ts:301-306`).
- `providerOptions` is entered as JSON text; a parse failure is a field error, not
  a crash.
- `maxSteps` below `MIN_MAX_STEPS` is rejected client-side with the same message
  the validator uses.
- No secret is rendered; the Providers tab shows keys only through `SecretField`
  (`src/ai/secret-field.tsx:13`).

## Architecture

```
src/ui/panels/chat-config.tsx   tabs: Thread | Providers | Vault
src/chat/config.ts              pure draft patch/validate helpers
src/chat/config.test.ts         unit tests
src/ui/shell.tsx                mounts ChatConfig in the rail; removes the
                                temporary notices from the center column
```

Thread tab data flow:

```
settings.providers -> provider select -> model select (provider.models)
        |
        v
draft { config fields } --validateThreadConfig--> validated | field errors
        |                                                   |
        | valid                                             | invalid
        v                                                   v
useChatStore.setThread({ ...thread, config: validated })   block save,
await saveThread(next)                                     render errors
```

Save-ownership decision: there is no engine config method (`src/chat/engine.ts:45-51`)
and `persist()` is private. Adding an engine method would widen the engine's
frozen API for a write the UI can already perform through the store plus
`saveThread`. Direct persistence is therefore the smaller change, and it stays on
the same encrypted path (`src/chat/persistence.ts:69-76`). The engine reads the
thread from `useChatStore` at the start of each run (`src/chat/engine.ts:202-209`),
so a saved config takes effect on the next turn without an engine change.

Default-provider decision: reuse `defaultProviderFor(settings)` from
`src/chat/threads.ts` (Phase 2) — the first configured provider with its
`defaultModel`. No new settings field is added, so no migration is needed and
existing vaults are unaffected. If no provider exists, the Thread tab shows an
empty state and the composer send action stays disabled; the empty state includes
a button that selects the Providers tab. This resolves the brainstorm's
unresolved question 5 without adding settings surface and keeps one
implementation of the rule.

## Files to Create / Modify

- Create: `src/ui/panels/chat-config.tsx`
- Create: `src/chat/config.ts`
- Create: `src/chat/config.test.ts`
- Modify: `src/ui/shell.tsx` (mount the panel, remove the temporary notices from
  the center column)

## Implementation Steps

1. Add `src/chat/config.ts`:
   - `validateConfigDraft(draft: unknown): { config?: ThreadConfig; errors:
     Record<string, string> }` wrapping `validateThreadConfig` and mapping a
     `ChatConfigError` message onto field keys by inspecting the message prefix
     (`temperature`, `topP`, `topK`, `maxOutputTokens`, `maxSteps`,
     `providerOptions`, `providerId`, `enabledSkills`), with a `_form` fallback
     for every message that carries no recognised prefix (e.g. `"A skill
     reference needs a non-empty id."`, `"The thread config must be an object."`).
     Enumerate the full `ChatConfigError` message set from
     `src/chat/types.ts:100-158` in the mapping table and keep it table-driven
     (red-team finding: error map).
   - `threadConfigPatch(draft)` building the `DeepPartial`-shaped patch.
   Keep the module React-free and import `defaultProviderFor` from
   `src/chat/threads.ts` instead of redefining it.
2. Write `src/chat/config.test.ts`: valid full config; each invalid field
   produces exactly one error key; an invalid skill reference and a non-object
   draft produce the `_form` key; `providerOptions` accepts `{}` and rejects an
   array and a non-plain object; `maxSteps` below 4 is rejected. Provider
   selection is covered by `src/chat/threads.test.ts` (Phase 2).
3. Add `src/ui/panels/chat-config.tsx`. Hold `activeTab` in state initialised from
   the shell's per-session panel state so a reload reopens the same tab. Render a
   tablist with `role="tablist"`/`role="tab"`/`aria-selected` and keyboard arrow
   handling, matching the shell rail's accessibility bar.
4. Thread tab: provider `<select>` from `settings.providers`, model `<select>`
   from the selected provider's `models` (falling back to `defaultModel`),
   a `systemInstruction` textarea, numeric inputs for the four params and
   `maxSteps`, a JSON textarea for `providerOptions`, and a skill multi-select
   sourced from `session.skillRegistry.list()` filtered to enabled ones from
   `settings.skills?.enabled` when that slice exists (Phase 5 adds it; until
   then list all registered skills). Render per-field errors from
   `validateConfigDraft`. Save calls the store + `saveThread`; Reset restores the
   thread's persisted config.
5. Providers tab: render `<ProvidersPanel />` directly, with no wrapper state.
6. Vault tab: render `<StorageWarning />` and `<DataEgressNotice />` unchanged.
   Do not add an idle-lock editor (red-team scope finding).
7. Remove the temporary `StorageWarning`/`DataEgressNotice` mounts from the center
   column and mount `ChatConfig` in the shell rail in `src/ui/shell.tsx`.
8. `pnpm test`, `pnpm lint`, `pnpm build`.
9. Browser gate: switch tabs; edit and save each field; confirm an invalid
   `maxSteps`, an invalid `topP`, malformed `providerOptions` JSON, and an invalid
   skill reference each block the save and show a visible error (including the
   `_form` fallback); confirm the next turn uses the new provider/model. Record in
   the journal.

## Todo

- [ ] `src/chat/config.ts` pure helpers + tests
- [ ] `src/ui/panels/chat-config.tsx` tab shell with keyboard support
- [ ] Thread tab edits every `ThreadConfig` field with field errors
- [ ] Providers tab mounts `ProvidersPanel` unchanged
- [ ] Vault tab mounts the two notices unchanged (no idle-lock editor)
- [ ] `defaultProviderFor` reused from Phase 2; no-provider empty state
- [ ] shell mounts the panel and drops the temporary center notices
- [ ] browser gate recorded
- [ ] lint / build / full test green

## Verification

- `pnpm test -- src/chat` passes, including `config.test.ts`.
- `pnpm test` full suite green (assert; do not encode a count).
- `pnpm lint` and `pnpm build` clean.
- Browser gate recorded in the journal: tabs, invalid-input blocking, a saved
  config reaching the next model call, and the idle-lock edit.
- Grep gate: `src/chat/config.ts` imports no React.

## Success Criteria

- [ ] Acceptance criterion 7: every `ThreadConfig` field is editable, invalid
      input is blocked with field errors, and nothing invalid reaches the engine.
- [ ] The saved config survives reopen and reload.
- [ ] `ProvidersPanel`, `StorageWarning`, and `DataEgressNotice` are mounted
      unchanged; no duplicate settings UI exists elsewhere in the shell.
- [ ] Creating a thread with no providers configured disables send and offers a
      path to the Providers tab.
- [ ] Every validator rejection renders a visible error, including unprefixed
      messages via the `_form` key.

## Risk Assessment

| Risk | Signal it broke | Pre-decided response |
|------|-----------------|----------------------|
| Direct persistence bypasses an engine invariant | A later engine run reads a stale config | Persist through `saveThread` and re-read from `useChatStore` at run start (already the engine's behaviour, `src/chat/engine.ts:202-209`). |
| A partially valid draft reaches the store | Thread is uneditable after reload | Validate the whole object before any write; the store write and `saveThread` are a single call site. |
| `providerOptions` JSON parse crashes the panel | Blank panel on malformed input | Parse inside the validator, map failure to a field error, keep the text. |
| Vault locks mid-edit | Save throws `VaultLockedError` | Catch and render a locked state; do not clear the draft. |
| Tab state is lost on every render because it lives in a parent | Active tab resets | Own the tab state in the panel and initialise from the shell's per-session state. |
| `settings` is null when not unlocked | Crash on `settings.providers` | Early-return a locked state, matching the existing `ProvidersPanel` guard (`ProvidersPanel.tsx:288`). |

## Security Considerations

- The panel renders no key material; provider credentials remain behind
  `SecretField` inside `ProvidersPanel`.
- `providerOptions` is parsed as JSON and rejected unless it is a plain object, so
  a prototype-bearing input cannot be persisted (`validateThreadConfig` already
  rejects `__proto__`/`constructor`/`prototype`, `src/chat/types.ts:55-59`,
  `:130-138`).
- Settings writes go through the vault write queue and are dropped after lock
  (`src/vault/store.ts:309-320`), so an edit cannot land after a lock.

## Next Steps

Phase 5 adds the Skills and Tools panels, including the optional
`Settings.skills.enabled` slice the Thread tab reads for its skill multi-select.
