---
phase: 2
title: "Phase 2: Context cap settings"
status: done
priority: P1
effort: "3h"
dependencies: []
---

# Phase 2: Context cap settings

## Goal

Add a configurable context cap and auto-compaction policy to the vault settings, with an optional per-thread override, and resolve the effective cap from both.

## Context

`src/ai/model-catalog.ts` discovers model ids from OpenAI-compatible endpoints and carries no context-window metadata, so the cap cannot be inferred and must be configured. `src/vault/settings.ts` holds the encrypted global settings with a `defaultSettings()` factory and field validation. `src/chat/types.ts` holds `ThreadConfig` with its own `validateThreadConfig`, and `src/chat/persistence.ts` reads threads tolerantly so an older record stays loadable.

## Files to Create / Modify

- Modify: `src/vault/settings.ts`
- Modify: `src/chat/types.ts`
- Modify: `src/chat/config.ts`
- Create: `src/chat/context-cap.ts`
- Create: `src/chat/context-cap.test.ts`
- Modify: `src/vault/settings.test.ts` (or the nearest existing settings test file)
- Modify: `src/chat/types.test.ts`

## Implementation Steps

1. In `src/vault/settings.ts`, add `context: { maxContextTokens: number; autoCompactRatio: number; autoCompactEnabled: boolean }` to `Settings`, default it in `defaultSettings()` to `{ maxContextTokens: 128000, autoCompactRatio: 0.8, autoCompactEnabled: true }`, and validate that `maxContextTokens` is a positive integer and `autoCompactRatio` is between 0.1 and 0.95.
2. Read the block tolerantly so a vault saved before this change loads and gets the defaults rather than failing validation.
3. In `src/chat/types.ts`, add optional `maxContextTokens?: number` to `ThreadConfig` and validate it with the existing `assertOptionalPositiveInteger` helper.
4. In `src/chat/config.ts`, add `maxContextTokens` to `ConfigDraft` as a text field and to `threadConfigPatch` following the existing number-or-undefined pattern, so the Thread config form can set an override.
5. In `src/chat/context-cap.ts`, add `resolveContextCap(settings, config)` returning `{ maxContextTokens, autoCompactRatio, autoCompactEnabled }` with the thread override applied to `maxContextTokens` only, and `shouldAutoCompact(contextTokens, cap)` returning true only when enabled and `contextTokens >= maxContextTokens * autoCompactRatio`.

## Verification

- `pnpm exec vitest run src/chat/context-cap.test.ts`
- `pnpm exec vitest run src/chat/types.test.ts src/chat/config.test.ts`
- `pnpm lint`

## Success Criteria

- [x] A settings record without a `context` block loads and reports the defaults.
- [x] An invalid ratio or a non-integer cap is rejected with a clear message.
- [x] `resolveContextCap` prefers the thread override for the cap and always takes the ratio and the enabled flag from global settings.
- [x] `shouldAutoCompact` returns false whenever `autoCompactEnabled` is false, regardless of the token count.
