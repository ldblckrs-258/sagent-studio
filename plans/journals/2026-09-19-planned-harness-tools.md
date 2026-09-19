---
title: Planned harness tools
date: 2026-09-19
summary: "Hard-mode plan for the ten-goal harness bundle (surgical edit, bounded search, persistent sandbox, approval gates, permission modes), additive to the core chat engine"
---

# Planned harness tools

## What happened
Ran `ak plan create harness-tools` then `ak plan add-phase` six times to produce `plans/260919-1821-harness-tools/` (`plan.md` plus `phase-01`..`phase-06`). Plan "Harness Tools — Autonomous Core", 48h, P1, additive to plan 3 (the implemented core chat engine). Two research reports landed under `plans/260919-1821-harness-tools/research/`, four hostile reviewers attacked the plan, and two validation sessions closed it. `ak plan validate` and `ak plan status` pass: 6 phases, 159 tasks, 0% complete. No product code was written. `plans/README.md` was updated to index the plan.

Ten goals: (1) `edit_file` exact-string surgical patch; (2) bounded `search`/grep; (3) `read_file` offset/limit plus recursive/glob `list_dir`; (4) `stat` + `move`/`copy`; (5) persistent sandbox sessions (warm worker, reset, idle reap); (6) approval gates; (7) progressive skill disclosure; (8) thread-scoped `update_plan`; (9) uniform tool-result envelopes; (10) conversation permission modes.

## Key findings that changed the design
- AI SDK v7 exposes call-level `toolApproval`, and assistant-ui's seam is `onRespondToToolApproval` (researcher-01).
- Browser sandbox persistence: Pyodide can hold warm state, but `setInterruptBuffer` is unusable without cross-origin isolation, so terminate-on-timeout is the only real kill (researcher-02). That is why `search` runs in a worker: a catastrophic regex kills the worker, not the tab.
- Mode and plan must live on `ChatThread` (sibling of `workspaceName`), not `ThreadConfig`, because `threadConfigPatch` (`src/chat/config.ts:52-77`) drops config fields on save (red-team Critical #2).
- `buildRunStream` has two call sites (`src/chat/engine.ts:292`, `src/chat/transport.ts:14`); both must be touched.
- `PyRunner` already keeps a warm worker while `JsRunner` terminates per run.
- Red-team Critical #3: the `sandbox` port never reached the run path and `js-worker.ts` had no port `init`.

## Decisions (Validation Sessions 1 and 2)
Session 1: gating narrowed to the named destructive built-ins (`write_file`, `remove`, `edit_file`, `move`, `run_js`, `run_python`) plus user tools whose kind is `sandbox-js`/`http` — the Critical #1 bypass fix. `search` runs in a worker under terminate-on-timeout. Added a byte-stream `copy` path (no 2 MiB ceiling, recreate empty dirs). `builtinProviders()` becomes config-aware so a stale Tools panel cannot make `load_skill` callable.

Session 2 (scope addendum): permission modes `read_only`/`editing`/`god`, default `editing`, stored on `ChatThread`; `decision = max(modeCeiling, policy)`; `remove` sits above the editing tier; `change_mode` always asks and is exempt even in `god`; composer toggle in `src/ui/composer-controls.tsx`.

## Red team
Four reviewers (Security Adversary, Failure Mode Analyst, Assumption Destroyer, Scope & Complexity Critic). 22 deduplicated findings accepted — 3 Critical, 10 High, 9 Medium; 1 scope-framing finding rejected, with the rejection recorded. Criticals: approval gate bypassed by user `sandbox-js`/`http` tools; thread plan dropped by the Config-panel save path; `sandbox` port never reached the run path with no `js-worker.ts` port `init`.

## Proven versus assumed
Proven by reading source: the `ChatThread` vs `ThreadConfig` save path, both `buildRunStream` call sites, and the warm `PyRunner` vs per-run `JsRunner`. Assumed, not proven: the native AI SDK approval pause/resume round-trip through this exact `streamText` + `toUIMessageStream` + `useExternalStoreRuntime` wiring. That path is gated behind a blocking spike in Phase 4 with a recorded fallback; if the spike fails, the plan runs on the fallback, not the native path.

## Next steps
Implement via `/ak:cook plans/260919-1821-harness-tools/plan.md`. Phase 4's approval spike blocks its own phase. Record every phase gate with date, build hash, browser, command, and observed result.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
