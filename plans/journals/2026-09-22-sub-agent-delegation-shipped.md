---
title: Sub-agent delegation shipped
date: 2026-09-22
summary: "Implemented four-tier model config, last-used model, nested spawn_agent runtime, agents panel, and reload reconciliation; all gates green."
---

# Sub-agent delegation shipped

## What happened

Implemented the six-phase `plans/260922-1354-sub-agent-delegation` plan end to end.

- **Tiered models**: `SubModelSettings`/`subModel` replaced by `ModelTier` +
  `TierModelsSettings` (`cheap|medium|high|max`), with `normalizeTierModels` and a
  lossless legacy `subModel → modelTiers.cheap` migration. New `src/ai/model-tier.ts`
  adds `resolveTierModel`/`createTierModel`, `MODEL_TIER_META`, and `tierForMode`.
- **Last-used model**: optional `Settings.lastModel`, `resolveLastModel` preferred by
  `defaultProviderFor`, and a debounced `rememberLastModel`.
- **Runtime core**: extracted one shared `resolveRunToolNames` (block list subtracted
  after the skill union) used by both `buildRunStream` and `resolveAgentToolNames`;
  added `modeRank`/`clampMode`, an abort-settling `AgentApprovalQueue`, and a bounded
  `runAgent` step loop using the SDK's async generic `toolApproval`.
- **spawn_agent**: `AgentSpawnPort` attached via a mutable parent context filled after
  `buildToolSet`; a session-scoped runtime owns caps and per-run controllers; every run
  persists as a child agent thread.
- **UI**: Agents rail panel with live/persisted transcripts, cancel, approval badge, and
  Allow/Deny-only cards; new `redactForDisplay` applied to old and new approval surfaces.

## Problems found and fixed

A post-implementation `code-reviewer` pass found three real gaps, since fixed:

1. Persisted `running` child threads were never reconciled (permanent phantom in the
   panel). `listAgentRuns` now runs each child through `rehydrateThread`.
2. Delegated runs dropped the parent thread's journal port, so their writes were not
   journaled. `portsFor` is now async and resolves the parent journal.
3. A failed awaited run was reported as `ok: true` with empty text. `spawn_agent` now
   maps `invalid_input`/`denied`/`limit_exceeded`/other failures to `toolFail`.

## Verification

`pnpm test` (1485 passed, 1 skipped), `pnpm lint`, and `pnpm build` all green.
New e2e test drives a parent model that calls `spawn_agent` through the real engine.

## Next steps

- `AgentRunStatus` is still declared once and re-exported from `agents/types`.
- Not changed: thread envelope version left at 1 for additive `agent` metadata.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
