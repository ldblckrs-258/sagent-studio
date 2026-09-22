---
phase: 1
title: "Tiered model settings and sub-model migration"
status: completed
priority: P1
effort: 1d
dependencies: []
---

# Phase 1: Tiered model settings and sub-model migration

## Overview

Replace the single `subModel` selection with a four-tier model configuration and
migrate existing vaults without losing their choice. The tiers are
`cheap | medium | high | max`, displayed as Spark / Forge / Prime / Oracle. The
cheap tier inherits the old `subModel` job: conversation naming and
user-sourced document-query rewriting.

## Key Insights

- `Settings` is vault-encrypted and versioned; `migrate()` already repairs
  legacy values (`LEGACY_AUTO_COMPACT_RATIO`) instead of failing the unlock, so
  `subModel` → `modelTiers.cheap` belongs there.
- `normalizeSubModel` already drops non-string/empty fields; reuse its body as
  `normalizeTierModel` so a hand-edited vault cannot smuggle bad values in.
- `defaultSettings()` deliberately omits optional blocks (`subModel`, `skills`)
  so absence means "not configured"; `modelTiers` must stay absent by default.
- `createSubModel` is best-effort and never throws into a background task; keep
  that contract in `createTierModel`.
- UI labels must not leak into the vault layer; keep them in the ai layer.

## Requirements

- Add `ModelTier`, `MODEL_TIERS`, `TierModelSettings`, `TierModelsSettings`.
- `Settings.modelTiers?: TierModelsSettings` replaces `Settings.subModel`.
- Migration reads legacy `subModel` into `modelTiers.cheap` only when cheap is
  unset, and drops the raw `subModel` key.
- `resolveTierModel`/`createTierModel` resolve one tier against providers and
  return null when the tier or provider is missing.
- `tierForMode(mode)` maps `read_only→cheap`, `editing→medium`, `god→high`;
  `max` is selected explicitly. Phase 4 consumes these mappings as the
  `spawn_agent` tier default, so none of the four tiers is dead config.
- Provider panel exposes all four tiers; README no longer says "sub-model".

## Related Code Files

- Modify: `src/vault/settings.ts`
- Modify: `src/vault/settings.test.ts`
- Create: `src/ai/model-tier.ts`
- Create: `src/ai/model-tier.test.ts`
- Delete: `src/ai/sub-model.ts`
- Delete: `src/ai/sub-model.test.ts`
- Modify: `src/chat/title.ts`
- Modify: `src/chat/title.test.ts`
- Modify: `src/session/session.ts`
- Modify: `src/settings/ProvidersPanel.tsx`
- Modify: `README.md`

## Implementation Steps

1. In `src/vault/settings.ts`, replace `SubModelSettings` with:
   `ModelTier = "cheap" | "medium" | "high" | "max"`, `MODEL_TIERS`,
   `TierModelSettings { providerId?; modelId? }`, and
   `TierModelsSettings = Partial<Record<ModelTier, TierModelSettings>>`.
2. Swap the `subModel?` field on `Settings` for `modelTiers?: TierModelsSettings`.
3. Rename `normalizeSubModel` to `normalizeTierModel` (same body). Add
   `normalizeTierModels(value)` that keeps only the four known tiers and returns
   `undefined` when empty.
4. In `migrate()`, destructure both `subModel` and `modelTiers` out of the merged
   object, build tiers via `normalizeTierModels`, then set `cheap` from
   `normalizeTierModel(rawSubModel)` only when `cheap` is unset. Attach
   `modelTiers` only when non-empty.
5. Create `src/ai/model-tier.ts` (moved from `sub-model.ts`): keep
   `ModelFactory`, rename `ResolvedSubModel`→`ResolvedTierModel`, add
   `resolveTierModel(settings, tier)` and `createTierModel(settings, tier, factory)`;
   add `MODEL_TIER_META` (label + blurb) and `tierForMode(mode)`.
6. Update `title.ts` (`titleModel` uses `createTierModel(settings, 'cheap', factory)`)
   and `session.ts` (`rewriteModel: (current) => createTierModel(current, 'cheap') ?? undefined`).
7. Replace `SubModelSection` in `ProvidersPanel.tsx` with a `ModelTiersSection`
   that renders one provider+model selector per tier, labelled from
   `MODEL_TIER_META`, writing `{ modelTiers: { [tier]: { providerId, modelId } } }`.
8. Delete the old `sub-model.ts`/`sub-model.test.ts`; port their cases to
   `model-tier.test.ts` and add tier-specific ones.
9. Update `settings.test.ts` sub-model block to assert the cheap migration
   (legacy → cheap, explicit cheap wins, malformed drops) and update
   `title.test.ts` patches to `modelTiers: { cheap: { ... } }`.
10. Update the README paragraph that describes the sub-model.

## Todo

- [x] Tier types + `modelTiers` field in `settings.ts`
- [x] `normalizeTierModel`/`normalizeTierModels` + legacy migration to cheap
- [x] `ai/model-tier.ts` with resolution, meta, and mode mapping
- [x] Update `title.ts` and `session.ts` call sites to the cheap tier
- [x] `ModelTiersSection` in `ProvidersPanel.tsx`
- [x] Tests updated/added; README updated

## Success Criteria

- `pnpm test src/vault/settings.test.ts src/ai/model-tier.test.ts src/chat/title.test.ts`
  passes.
- A vault containing `subModel` unlocks with `modelTiers.cheap` set and no
  `subModel` key; `defaultSettings().modelTiers` is `undefined`.
- `pnpm build` (tsc) and `pnpm lint` pass — the rename/delete of shared types is
  type-gated here, not deferred to the final phase.

## Risk Assessment

- **Migration loss:** reading `subModel` after `deepMerge` requires destructuring
  so it does not survive into `rest`. Verify with a migration test asserting the
  key is gone.
- **Silent provider drift:** a tier may name a provider that was deleted; the
  resolver must return null and callers must fall back, never throw.

## Security Considerations

- No new egress; tier ids and model ids only. Keep `normalizeTierModels`
  tolerant so a hand-edited vault cannot crash the unlock.

## Next Steps

- Phase 2 adds `lastModel` to the same settings block using the same normalize +
  migrate pattern.
