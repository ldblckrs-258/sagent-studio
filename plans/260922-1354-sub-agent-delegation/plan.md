---
title: "Sub-agent delegation"
description: "Parent agent can delegate bounded tasks to nested sub-agents (await or background), configurable through a four-tier model config and a persisted last-used model."
status: completed
priority: P1
effort: 6d
branch: main
tags: [feature, agents, orchestration, settings]
blockedBy: []
blocks: []
created: 2026-09-22
---

# Sub-agent delegation

## Overview

Give the main agent a way to hand a bounded task to a fresh, nested agent. A
single `spawn_agent` tool accepts a prompt, a permission mode no higher than the
parent's, optional skills to activate, optional tools to exclude, an optional
model tier, and an `await`/background choice. An awaited agent returns its result
inline; a background agent runs detached, streams into a new Agents panel, and
appends a short summary to the parent conversation when it settles.

Model selection for delegated work is driven by a four-tier configuration
(cheap / medium / high / max, shown as Spark / Forge / Prime / Oracle). The
existing single `subModel` setting migrates into the **cheap** tier and keeps
driving conversation naming and document-query rewriting. The last model the
user picked is persisted so a new conversation starts on it.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Four-tier model config with a lossless `subModel` → cheap migration | P1 |
| 2 | Sub-agent runtime: nested run loop, mode clamp, toolset resolver, approval queue | P1 |
| 3 | `spawn_agent` tool with await and background modes, one level deep | P1 |
| 4 | Agents panel: live transcripts, cancel, and queued approvals | P1 |
| 5 | Persisted last-used model seeds new conversations | P2 |
| 6 | Docs, tool guide, and end-to-end verification | P2 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Tiered model settings and sub-model migration](./phase-01-tiered-model-settings.md) | Completed |
| 2 | [Persist the last-used model](./phase-02-last-used-model.md) | Completed |
| 3 | [Agent runtime core](./phase-03-agent-runtime-core.md) | Completed |
| 4 | [spawn_agent tool and background notices](./phase-04-spawn-agent-tool.md) | Completed |
| 5 | [Agents panel and approval queue UI](./phase-05-agents-panel-ui.md) | Completed |
| 6 | [Docs and end-to-end verification](./phase-06-docs-and-e2e.md) | Completed |

## Cross-Plan Dependencies

| Relationship | Plan | Status |
|-------------|------|--------|
| None | — | — |

## Dependencies

- Phase 3 needs Phase 1 (tier resolution) and inherits Phase 2's settings shape.
- Phase 4 needs Phase 3; Phase 5 needs Phase 4.
- Reuses `ToolRegistry`, `modeCeiling`/`isWithinCeiling`, `skillRegistry.toolNamesFor`,
  `composeSystemPrompt`, and the `streamText`/`MockLanguageModelV4` test harness.
- No new runtime dependency and no new network egress.

## Success Criteria

- [x] `spawn_agent` runs a delegated task inline (await) and detached (background).
- [x] Effective mode is clamped to at most the parent mode; excluded/blocked tools absent.
- [x] A background agent that hits a consent-requiring tool pauses and queues a real prompt.
- [x] Four tiers are configurable in Providers; legacy `subModel` migrates to cheap.
- [x] New conversations start on the last-used model when it still resolves.
- [x] `pnpm test`, `pnpm lint`, and `pnpm build` pass.

## Validation Log

Four decisions confirmed with the user after the red-team pass:

| Topic | Decision | Propagated |
|-------|----------|-----------|
| Delegated approvals | Allow / Deny only; never persist, never offer "Always allow" | Phases 3, 5 |
| Blocked agent tools | Block `restore`, `change_mode`, `update_plan`, `spawn_agent` | Phase 3 |
| Run durability | Persist each run as a child agent thread; in-memory store overlays live runs | Phases 4, 5, 6 |
| Background completion | Append one summary notice; do not auto-continue the parent | Phase 4 |

<!-- Updated: Validation Session 1 - child-thread durability, Allow/Deny-only delegated approvals -->

### Whole-Plan Consistency Sweep

- Phase 4 now owns child-thread persistence (`ChatThread.agent`,
  `listAgentRuns`, cascade delete) instead of an in-memory-only registry; Phase 5
  reads persisted children and Phase 6 tests the interrupt reconciliation.
- No phase still claims runs are ephemeral or persisted as notices only.
- "Always allow" appears only as a rejected option in the red-team table and a
  negative requirement in Phases 3/5.

## Red Team Review

Four hostile lenses (Assumptions, Failure, Security, Scope) produced 24 findings.
All 6 Critical/High blockers were accepted and folded into the phase files.

| # | Severity | Finding | Disposition | Applied |
|---|----------|---------|-------------|---------|
| 1 | Critical | `spawn_agent` availability is circular: the `agents` port was built from `Object.keys(toolSet)` before the toolset exists (`registry.ts:129`, `engine.ts:369`) | Accept | Phase 4 — mutable parent context, port attached before `buildToolSet`, `toolNames` filled after |
| 2 | Critical | Detached runs have no lifecycle owner; they survive lock/delete/dispose (`engine.ts:466`, `session.ts:320`, `store.ts:169`) | Accept | Phase 4 — runtime owns controllers + global abort; `abortThread` on teardown |
| 3 | Critical | Pending-approval promises never settle on abort/lock/delete (`phase-03:84`) | Accept | Phase 3 — `createApprovalQueue({ signal })` with `settleAll(false)`; abort tests |
| 4 | Critical | Skill union applied after blocks re-adds `change_mode`/`spawn_agent` un-gated; `toolNamesFor` fails open on a miss (`registry.ts:140-161`, `schema.ts:43`) | Accept | Phase 3 — shared resolver, blocks subtracted last, unknown skill is `invalid_input` |
| 5 | High | `buildRunStream` has no thread context and a second caller (`transport.ts:14`) | Accept | Phase 4 — optional final `agentContext`; `transport.ts` unchanged (no agents port) |
| 6 | High | Await agents double-report (inline result + notice) | Accept | Phase 4 — `onSettle` wired for background only |
| 7 | High | Notice queue flushes only in `startRun`'s finally; manual `compact` holds the same controller (`engine.ts:623-641`) | Accept | Phase 4 — per-thread in-flight counter, `flushNotices` from both finallys |
| 8 | High | In-memory runs vs. persisted `status:'running'` = permanent phantom after reload (`engine.ts:938`) | Accept | Phase 4/6 — rehydrate reconciliation to `interrupted` + test |
| 9 | High | No redaction exists; the plan's "reuse" claim was false (`approval-prompt.tsx:50-93`, `http.ts:160`) | Accept | Phase 5 — new `redactForDisplay`, applied to old and new UI |
| 10 | High | Delegated `allow-always` durably weakens the parent policy (`engine.ts:307-314`) | Accept | Phase 3/5 — delegated approvals are Allow/Deny only |
| 11 | High | `restore` not blocked, reverts the parent's shared journal (`history.ts:59-118`) | Accept | Phase 3 — `restore` added to `BLOCKED_AGENT_TOOLS` |
| 12 | High | Approval-by-`execute`-wrapping is redundant; async `toolApproval` exists (`index.d.ts:3111`) | Accept | Phase 3 — use async `toolApproval`; drop execute wrapping |
| 13 | High | `resolveAgentToolNames` duplicates `buildRunStream`'s narrowing | Accept | Phase 3 — one shared resolver |
| 14 | High | Phase 4 omits `session.test.ts`/`isAvailable`; `builtinProviders` hardcodes providers (`session.ts:365`) | Accept | Phase 4 — `isAvailable: () => true`, add provider + update `session.test.ts` |
| 15 | Medium | Three of four tiers unreachable config; caps scope unspecified; journal provenance absent; e2e mocks cannot target a sub-model; type gate deferred | Accept | Phases 1-6 — `tierForMode` consumed by `spawn_agent` defaults, `max` explicit; global + per-thread caps count awaited runs; `restore` blocked and journal sharing documented as a risk; injectable model factory; `pnpm build` gate per phase |

Rejected: none. No finding was reversed by verified evidence.

### Whole-Plan Consistency Sweep

- Removed the `execute`-wrapping design from Phase 3; no phase references it.
- `BLOCKED_AGENT_TOOLS` is defined once (Phase 3) and consumed in Phase 4.
- `allow-always` no longer appears for delegated approvals in Phases 3 or 5.
- The migration name `subModel` → `modelTiers.cheap` is consistent across Phases
  1, 2, and 6.
- `buildRunStream`'s optional `agentContext` (Phase 4) is compatible with the
  unchanged `transport.ts` caller; `engine.ts:873` is the only caller updated.
- `pnpm build` type gate now appears in Phases 1, 2, 3, and 6.

No unresolved contradictions remain.

<!-- slug: sub-agent-delegation -->
