---
phase: 2
title: "Persist the last-used model"
status: completed
priority: P2
effort: 0.5d
dependencies: [1]
---

# Phase 2: Persist the last-used model

## Overview

Remember the provider/model the user last chose and seed every new conversation
with it. Today `defaultProviderFor` always returns the first configured
provider's default model, so a user who works with one model re-selects it on
every new chat.

## Key Insights

- New conversations are created in three places that all call
  `defaultProviderFor`: `chat/active-thread.ts` (`ensureActiveThread`),
  `ui/panels/conversations.tsx` (`create`), and the composer fallback in
  `ui/composer-controls.tsx`. Changing the one resolver covers all three.
- The vault layer must not import `src/chat`, so `Settings` needs a structural
  `lastModel` shape, mirroring how `PersistedSkillRef` mirrors `SkillRef`.
- Writing to the vault encrypts the whole settings blob, so a write on every
  picker keystroke would be wasteful: debounce and swallow lock races.

## Requirements

- `Settings.lastModel?: { providerId?: string; modelId?: string }`, optional and
  absent by default, normalized in `migrate()`.
- `defaultProviderFor(settings)` prefers `lastModel` when it resolves against a
  configured provider, else falls back to the first provider.
- A model id that no longer exists under its provider falls back to that
  provider's `defaultModel` rather than dropping the whole selection.
- `rememberLastModel(selection)` debounces the vault write and never surfaces a
  lock failure.

## Related Code Files

- Modify: `src/vault/settings.ts`
- Modify: `src/vault/settings.test.ts`
- Modify: `src/chat/threads.ts`
- Modify: `src/chat/threads.test.ts`
- Create: `src/chat/last-model.ts`
- Create: `src/chat/last-model.test.ts`
- Modify: `src/ui/composer-controls.tsx`
- Modify: `src/ui/panels/chat-config.tsx`

## Implementation Steps

1. In `src/vault/settings.ts` add `LastModelSettings` and the optional
   `lastModel` field. Add `normalizeLastModel(value)` (trim strings, drop empty)
   and wire it through `migrate()` beside `modelTiers`, dropping the raw key when
   it sanitizes to nothing.
2. In `src/chat/threads.ts` add `resolveLastModel(settings): ProviderSelection | null`:
   the provider must exist; a `modelId` must be one of its models, otherwise use
   the provider's `defaultModel`.
3. Change `defaultProviderFor` to return `resolveLastModel(settings)` first, then
   the existing first-provider rule.
4. Create `src/chat/last-model.ts` with a debounced `rememberLastModel(selection)`
   (single module-level timer, ~500ms) that calls
   `useVaultStore.getState().update({ lastModel })` and catches rejections. Export
   a `flushLastModel()` for tests.
5. Call `rememberLastModel` from the composer's `applyConfig` when the patch
   carries `providerId`/`modelId`, and from the ThreadTab save in
   `chat-config.tsx` after a successful write.
6. Extend `settings.test.ts` (migration + default absence) and `threads.test.ts`
   (prefers last model, falls back on unknown provider, falls back to
   `defaultModel` on unknown model). Add `last-model.test.ts` using fake timers
   to assert one debounced write and swallowed rejection.

## Todo

- [x] `lastModel` in settings + normalization + migration
- [x] `resolveLastModel` and `defaultProviderFor` preference
- [x] Debounced `rememberLastModel` helper
- [x] Composer + Thread config call sites
- [x] Tests for resolution and debounce

## Success Criteria

- A new conversation starts on the last-used model when it still resolves.
- `pnpm test src/vault/settings.test.ts src/chat/threads.test.ts src/chat/last-model.test.ts`
  passes.
- `pnpm build` (tsc) and `pnpm lint` pass.

## Risk Assessment

- **Debounce vs. reload:** a picker change followed by an immediate reload may
  not persist. Acceptable; flush on `visibilitychange` is optional and must not
  block the phase.

## Security Considerations

- The selection is provider/model ids only; no secret is stored beyond what the
  vault already holds. No new egress.

## Next Steps

- Phase 3 consumes `Settings.modelTiers`; nothing in Phase 3 depends on
  `lastModel`.
