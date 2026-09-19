---
phase: 6
title: "Thread Plan Tool and Whole-Suite Verification"
status: pending
priority: P1
effort: "7h"
dependencies: [1, 2, 3, 4, 5]
---

# Phase 6: Thread Plan Tool and Whole-Suite Verification

## Context Links

- Plan: [`plan.md`](./plan.md) — goal 8 and the whole-suite acceptance criteria;
  Key Decision "`update_plan` persists on `ChatThread`, beside `workspaceName`".
  <!-- Updated: Red Team Session 1 - plan lives on ChatThread, not ThreadConfig -->
- Thread model: `src/chat/types.ts:16` (`ThreadConfig`), `:26` (`ChatThread`), `:40`
  (`defaultThreadConfig`), `:102` (`validateThreadConfig`), `:63`
  (`assertOptionalNumber` as the validation style), `:85` (`validateSkillRefs` as the
  array-of-objects validation precedent), `:57` (`hasForbiddenKey`).
- Additive tolerance precedent: `src/chat/persistence.ts:25` (`validateThread`),
  `:57` (the `workspaceName` optional-and-tolerant read), `:9`
  (`THREAD_ENVELOPE_VERSION` — not bumped).
- Engine per-run ports: `src/chat/engine.ts:92` (`buildRunStream`), `:102` (the
  `ports` object), `:284` (`executeRun` holds the `thread`), `:227` (`persist`).
- Store and persistence for the write path: `src/chat/store.ts:33`
  (`setThread`), `src/chat/persistence.ts:83` (`saveThread`).
- Per-run port pattern established in Phase 5: `ToolRuntimePorts` assembled inside
  `buildRunStream` (`src/chat/engine.ts:102`), with optional port members on
  `PipelineDeps`; `src/tools/types.ts:58`.
  <!-- Updated: Red Team Session 1 - per-run ports on PipelineDeps -->
- Provider pattern: `src/tools/builtin/code.ts:34` (`CodeRunnerSource`).
- UI mount point: `src/ui/shell.tsx:411-415` (`AssistantRuntimeProvider` +
  `Thread`).
- Thread-config validation tests live in `src/chat/config.test.ts:54`
  (`validateThreadConfig draft`), which drives `validateThreadConfig` through
  `validateConfigDraft` and `threadConfigPatch` (`src/chat/config.ts:52`). That path
  never builds a `plan` field, which is exactly why the plan lives on `ChatThread`
  and is validated through `validateThread` (`src/chat/persistence.ts:25`) instead;
  this phase tests that path from `src/chat/persistence.test.ts`.
  <!-- Updated: Red Team Session 1 - plan lives on ChatThread, not ThreadConfig -->
- Test harness for a tool loop: `src/chat/engine.test.ts:67` (`toolStep`), `:78`
  (`makeModel`), `:142` (`memoryStore`), `:162` (`setup`).

## Goal

Give the model a place to write down what it is doing, and give the user a place to
see it. The plan is thread-scoped, persists with the thread, needs no new table, and
renders next to the conversation. Then verify the whole bundle end to end: nine goals,
one integrated turn, and a green `pnpm test`, `pnpm lint`, `pnpm build`.

## Requirements

**Plan model.**

- `src/chat/types.ts` adds:
  ```ts
  export type PlanItemStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'
  export interface PlanItem { id: string; text: string; status: PlanItemStatus }
  export const MAX_PLAN_ITEMS = 50
  export const MAX_PLAN_TEXT_LENGTH = 500
  ```
- `ChatThread` (`src/chat/types.ts:26`) gains an optional `plan?: PlanItem[]` as a
  sibling of `workspaceName` (`:34`), NOT a field on `ThreadConfig`. It is carried
  through `validateThread` (`src/chat/persistence.ts:25`), mirroring the tolerant
  `workspaceName` read (`:57`). Reason: the Config panel rebuilds `config` from the
  fixed form projection `threadConfigPatch` (`src/chat/config.ts:52-77`) and saves
  `{ ...thread, config: result.config }` (`src/ui/panels/chat-config.tsx:75`), which
  would silently drop a plan held on `config`.
  <!-- Updated: Red Team Session 1 - plan lives on ChatThread, not ThreadConfig -->
- Plan validation and normalization live in exactly one module, `src/chat/plan.ts`
  (`validatePlanItems`, `normalizePlanItems`, `planCounts`). `validateThread` and the
  `update_plan` tool both call that module; neither reimplements the caps or the
  forbidden-key check. An array of at most `MAX_PLAN_ITEMS` plain objects, each with
  a non-empty string `id` of at most 64 characters, a non-empty string `text` of at
  most `MAX_PLAN_TEXT_LENGTH` characters, and a `status` in the four-value set is
  valid; an item with a forbidden key (`__proto__`, `constructor`, `prototype`) is
  rejected, following `hasForbiddenKey` (`:57`).
  <!-- Updated: Red Team Session 1 - single plan validation source -->
- A missing `plan` is omitted, so an existing thread (`src/chat/persistence.ts:57`
  pattern) loads unchanged. The envelope version stays `1` and
  `defaultThreadConfig` does NOT set a plan.
- Adding a plan does not change any other field's validation.

**`update_plan` tool.**

- A new `src/tools/builtin/plan.ts` exports `createPlanToolProvider()` with
  `NAMES = ['update_plan']` and `isAvailable(ports) => ports.plan !== undefined`.
- Input: `{ items: Array<{ id?: string; text: string; status: string }> }`.
  Semantics are replace-all: the supplied list becomes the thread's plan. The tool
  description states this so the model always sends the full list.
- Normalization: `text` is trimmed; an absent or blank `id` is derived
  deterministically from the item's 1-based index (`p1`, `p2`, …); `status` defaults
  to `pending` and is rejected as `invalid_input` when it is not one of the four
  values. More than `MAX_PLAN_ITEMS` items, a missing `items` array, or an item that
  is not an object returns `invalid_input`.
- Output on success: `{ items, counts }` inside a Phase 1 envelope, where `counts`
  maps each status to its total, so the model can confirm its own write.
- `ToolRuntimePorts` gains an optional
  `plan?: ThreadPlanPort` with
  `get(): ReadonlyArray<PlanItem>` and `set(items: readonly PlanItem[]): Promise<void>`.
- `update_plan` declares no `code-runner`, `filesystem-write`, or `network`
  capability, so the Phase 4 capability gate does not gate it; it writes only the
  current thread's own record.
  <!-- Updated: Red Team Session 1 - capability-based approval gating -->

**Persistence.**

- `DefaultEngine` builds a `ThreadPlanPort` per run from the thread id:
  `get()` reads `useChatStore.getState().threads[id]?.plan ?? []`; `set()` writes a
  new `ChatThread` through `useChatStore.getState().setThread` and then
  `this.deps.threadStore.saveThread(next)` with an updated `updatedAt`, reusing the
  same failure handling as `persist` (`src/chat/engine.ts:227`) for
  `VaultLockedError`. The `plan` is a top-level field on the thread, so a Config-panel
  save that replaces `config` cannot drop it.
  <!-- Updated: Red Team Session 1 - plan lives on ChatThread, not ThreadConfig -->
- No new Dexie table and no new vault record. `src/vault/db.ts` is untouched.
- A vault lock during the write drops the in-memory thread exactly as `persist`
  does today, and the tool returns a `runtime_error` failure rather than throwing.

**UI.**

- A new `src/ui/plan-panel.tsx` (`PlanPanel`) reads the active thread's `plan` from
  `useChatStore` and renders each item with its status. It is hidden when the plan is
  empty and shows pending/in-progress/completed/cancelled distinctly. It does not
  edit the plan; the model owns it. A user-facing clear action is out of scope.
  <!-- Updated: Red Team Session 1 - plan lives on ChatThread, not ThreadConfig -->
- It is mounted in `src/ui/shell.tsx` inside the main column, above the
  `AssistantRuntimeProvider` block at `:411-415`, so it sits with the conversation
  rather than in a side panel.
- Panels are not unit-tested in this repository; the plan model and the tool are
  covered by unit and integration tests instead.

**Whole-suite verification.**

- One end-to-end acceptance test drives a single multi-tool turn through the real
  engine and asserts the bundle works together.
- `pnpm test`, `pnpm lint`, and `pnpm build` are green.
- `plan.md` is updated: the phase table statuses, the success-criteria checklist,
  and an implementation log entry recording the evidence and any gate that remains
  manual.

## Architecture

**Plan data flow.**

```
model → update_plan({ items })            // full replacement
      → planToolProvider.execute
      → ports.plan.set(normalizedItems)
      → engine plan port
      → useChatStore.setThread({ ...thread, plan: items })
      → threadStore.saveThread(next)      // encrypted, existing envelope v1
      → PlanPanel re-renders from the store
next run → buildRunStream → ports.plan.get() → the model sees its own plan back
                                          via the tool result it just wrote
```
<!-- Updated: Red Team Session 1 - plan lives on ChatThread, not ThreadConfig -->

The plan is deliberately not injected into the system prompt. The model already
sees its plan in the tool result it wrote, and the user sees it in the panel; adding
a third copy to the prompt would grow every request for no new information.

**Why a thread field.** `ChatThread` already travels with the thread, carries the
tolerant `workspaceName` sibling, and is persisted inside the existing encrypted
envelope. Putting the plan on `ThreadConfig` instead would be dropped by the Config
panel's `threadConfigPatch` projection (`src/chat/config.ts:52-77`) and
`{ ...thread, config: result.config }` save
(`src/ui/panels/chat-config.tsx:75`). A new table would need a new Dexie version, a
new record type, a new write path, and a new lock story — for a field that is
intrinsically thread-scoped.
<!-- Updated: Red Team Session 1 - plan lives on ChatThread, not ThreadConfig -->

**Why the port is per run.** The plan belongs to one thread, and `executeRun` is the
only place that knows the thread id and owns the store. Building the port there (the
same shape as Phase 5's skill port) keeps a tool from writing another thread's plan.

**End-to-end acceptance turn.** The test drives one model loop over a fake
workspace and makes the single cross-feature assertion no phase test makes: the
bundle composes in one real turn. Per-tool and per-phase behavior is covered by the
phase suites, so this file asserts only composition, not each tool's semantics.

```
turn: "update the config and track it"
 step 1 → search({ pattern: "TODO" })        → hits with path:line:text
 step 2 → read_file({ path: "a.txt" })       → content + totalLines
 step 3 → edit_file({ path: "a.txt", ... })  → replacement applied (approval: allow)
 step 4 → update_plan({ items: [...] })      → plan written to the thread record
 step 5 → text                                → final answer
assert: every tool part is an `ok` envelope; the file on the fake workspace changed;
        the persisted thread carries the plan; the prompt carried a skill index only.
```
<!-- Updated: Red Team Session 1 - e2e reduced to the cross-feature assertion -->

## Files to Create / Modify

Create:

- `src/chat/plan.ts` — `validatePlanItems`, `normalizePlanItems`, `planCounts`.
- `src/chat/plan.test.ts`
- `src/tools/builtin/plan.ts` — `createPlanToolProvider`.
- `src/tools/builtin/plan.test.ts`
- `src/ui/plan-panel.tsx` — `PlanPanel`.
- `src/chat/harness-e2e.test.ts` — the reduced single cross-feature acceptance turn.
  <!-- Updated: Red Team Session 1 - e2e reduced to the cross-feature assertion -->

Modify:

- `src/chat/types.ts` — `PlanItemStatus`, `PlanItem`, the two caps, and the optional
  `plan` field on `ChatThread` (`:26`). This phase does NOT add `plan` to
  `ThreadConfig` and does NOT validate it in `validateThreadConfig`.
  <!-- Updated: Red Team Session 1 - plan lives on ChatThread, not ThreadConfig -->
- `src/chat/persistence.ts` — carry `plan` through `validateThread` (`:25`)
  additively (no version bump), delegating to `src/chat/plan.ts` for validation.
  <!-- Updated: Red Team Session 1 - single plan validation source -->
- `src/tools/types.ts` — `ThreadPlanPort` and the optional `plan` member.
- `src/chat/engine.ts` — build the per-run plan port and deliver it through
  `PipelineDeps`, merged into the `ports` object at `:102`, so both `buildRunStream`
  call sites inherit it.
  <!-- Updated: Red Team Session 1 - per-run ports on PipelineDeps -->
- `src/chat/engine.test.ts` — a plan write through the port.
- `src/chat/config.ts` and `src/ui/panels/chat-config.tsx` — no behavior change is
  required, but list them because the plan field lives on `ChatThread` and the
  Config-panel save path must preserve it. Add a regression test that saving a config
  leaves an existing `thread.plan` intact.
  <!-- Updated: Red Team Session 1 - plan lives on ChatThread, not ThreadConfig -->
- `src/session/session.ts` — register `createPlanToolProvider`. `builtinProviders()`
  builds a fixed ports object with no thread context, so either make it config-aware
  or drop the claim that `update_plan` appears as available in the Tools panel; do not
  weaken per-thread gating.
  <!-- Updated: Red Team Session 1 - builtinProviders cannot express per-run isAvailable -->
- `src/ui/shell.tsx` — mount `PlanPanel`.
- `plan.md` — phase table, success criteria, implementation log.

## Test Plan

Unit — `src/chat/plan.test.ts`

- A valid list round-trips through `validatePlanItems` unchanged.
- A missing `plan` validates to `undefined` and is omitted from the config.
- A plan with 51 items is rejected; a text of 501 characters is rejected; an empty
  `id` or `text` is rejected; an unknown `status` is rejected.
- An item carrying `__proto__` is rejected.
- `normalizePlanItems` derives `p1`, `p2`, … for missing ids deterministically and
  defaults `status` to `pending`.
- `planCounts` counts each status, including zero counts for absent statuses.

Unit — `src/tools/builtin/plan.test.ts`

- The provider contributes exactly `['update_plan']`.
- `isAvailable` is false without a `plan` port.
- `update_plan` with a valid list calls `port.set` once with the normalized items
  and returns `{ items, counts }` in an `ok` envelope.
- A second call with a shorter list replaces the plan rather than merging.
- A missing `items` array, a non-object item, an over-long list, and an unknown
  status each return `invalid_input` and do NOT call `port.set`.
- A rejected `port.set` returns a `runtime_error` failure envelope, not a thrown
  error.
- The port's `get()` is reflected in the hint on an `invalid_input`.

Persistence — `src/chat/persistence.test.ts`

- A thread saved with a plan loads with the same plan.
- A thread envelope written without `plan` loads with `plan === undefined` and no
  error, proving backward compatibility.
- `validateThread` accepts a thread with a valid `plan` and with no `plan`, and
  rejects an invalid plan with an error whose message names `plan`, delegating to
  `src/chat/plan.ts` rather than reimplementing the caps.
  <!-- Updated: Red Team Session 1 - single plan validation source -->
- A Config-panel-style save (a `threadConfigPatch` candidate written as
  `{ ...thread, config }`) leaves an existing `thread.plan` present.
  <!-- Updated: Red Team Session 1 - plan lives on ChatThread, not ThreadConfig -->

Integration — `src/chat/engine.test.ts`

- A run whose model calls `update_plan` writes the plan into the store and the
  thread store, and the next run's port reads it back.
- A vault-locked save drops the thread from the store without an unhandled
  rejection, matching the existing lock test at `:511`.

End-to-end — `src/chat/harness-e2e.test.ts` (reduced to the cross-feature assertion)

- The five-step turn above completes; every tool part carries an `ok` envelope.
- The persisted thread's top-level `plan` matches what the model sent.
  <!-- Updated: Red Team Session 1 - plan lives on ChatThread, not ThreadConfig -->
- The turn's tool list includes `search`, `read_file`, `edit_file`,
  `update_plan`, and `load_skill`.
  <!-- Updated: Red Team Session 1 - e2e reduced to the cross-feature assertion -->

Whole suite

- `pnpm test` green (new suites included, existing suites unmodified in intent).
- `pnpm lint` green.
- `pnpm build` green (`tsc -b` plus `vite build`).
- Every manual gate recorded under
  `plans/260919-1821-harness-tools/reports/` is referenced from `plan.md`.

## Implementation Steps

1. Add the plan types and the optional `plan` field on `ChatThread` in
   `src/chat/types.ts` (NOT on `ThreadConfig`). Write `src/chat/plan.ts` with the
   pure helpers as the single validation/normalization source, and
   `src/chat/plan.test.ts`. Run them.
   <!-- Updated: Red Team Session 1 - plan lives on ChatThread, not ThreadConfig -->
2. Carry `plan` through `validateThread` in `src/chat/persistence.ts` additively,
   mirroring the `workspaceName` pattern at `:57` and delegating to `src/chat/plan.ts`.
   Add the persistence tests, including the Config-panel-save-preserves-plan
   regression.
   <!-- Updated: Red Team Session 1 - single plan validation source -->
3. Add `ThreadPlanPort` and the optional `plan` member to
   `src/tools/types.ts`.
4. Write `src/tools/builtin/plan.ts` and its tests against an inline port fake.
5. In `src/chat/engine.ts`, add the per-run plan port on `DefaultEngine` and deliver
   it through `PipelineDeps`, merged into the `ports` object at `:102` so both
   `buildRunStream` call sites (`src/chat/engine.ts:292`, `src/chat/transport.ts:14`)
   inherit it. Add the engine tests.
   <!-- Updated: Red Team Session 1 - per-run ports on PipelineDeps -->
6. Register the provider in `src/session/session.ts`. Either make
   `builtinProviders()` config-aware or drop the claim that `update_plan` appears as
   available in the Tools panel; the per-thread port gate is the real constraint.
   <!-- Updated: Red Team Session 1 - builtinProviders cannot express per-run isAvailable -->
7. Build `src/ui/plan-panel.tsx` and mount it in `src/ui/shell.tsx` above the
   runtime provider.
8. Write `src/chat/harness-e2e.test.ts` as the reduced cross-feature assertion and
   make it pass. Per-tool behavior is covered by the phase suites; a failure here is a
   bundle composition defect, not a per-tool test defect.
   <!-- Updated: Red Team Session 1 - e2e reduced to the cross-feature assertion -->
9. Run `pnpm test`, `pnpm lint`, and `pnpm build`. Fix regressions rather than
   weakening assertions.
10. Update `plan.md`: phase statuses, success-criteria checklist, an implementation
    log entry with the evidence, and any manual gate left unverified. Then run
    `ak plan validate plans/260919-1821-harness-tools`.

## Todo

- [ ] `PlanItem` / `PlanItemStatus` / caps in `src/chat/types.ts`
- [ ] `ChatThread.plan` (sibling of `workspaceName`), NOT `ThreadConfig.plan`;
      missing plan still loads
      <!-- Updated: Red Team Session 1 - plan lives on ChatThread, not ThreadConfig -->
- [ ] `src/chat/plan.ts` as the single validation/normalization source + tests
      <!-- Updated: Red Team Session 1 - single plan validation source -->
- [ ] `plan` carried through `validateThread` in `src/chat/persistence.ts` without a
      version bump, delegating to `src/chat/plan.ts`
- [ ] Config-panel-save regression: saving a config leaves `thread.plan` present
      <!-- Updated: Red Team Session 1 - plan lives on ChatThread, not ThreadConfig -->
- [ ] `ThreadPlanPort` + optional `plan` on `ToolRuntimePorts`
- [ ] `src/tools/builtin/plan.ts` `update_plan` + tests
- [ ] Per-run plan port delivered through `PipelineDeps` and merged at
      `src/chat/engine.ts:102`, covering both `buildRunStream` call sites
      <!-- Updated: Red Team Session 1 - per-run ports on PipelineDeps -->
- [ ] Provider registered in `src/session/session.ts`; `builtinProviders()` either
      config-aware or the Tools-panel-availability claim dropped
      <!-- Updated: Red Team Session 1 - builtinProviders cannot express per-run isAvailable -->
- [ ] `src/ui/plan-panel.tsx` mounted in `src/ui/shell.tsx`, reading the thread-level
      `plan`
- [ ] `src/chat/harness-e2e.test.ts` green (reduced cross-feature assertion)
      <!-- Updated: Red Team Session 1 - e2e reduced to the cross-feature assertion -->
- [ ] `pnpm test`, `pnpm lint`, `pnpm build` green
- [ ] `plan.md` statuses, success criteria, and implementation log updated
- [ ] `ak plan validate plans/260919-1821-harness-tools` passes

## Success Criteria

- [ ] `update_plan` replaces the thread's plan, returns the normalized list and
      counts, and rejects malformed input as `invalid_input` without writing.
- [ ] The plan persists inside the existing encrypted thread record, survives a
      reload, and appears in the UI panel without a new Dexie table.
- [ ] The plan lives on `ChatThread`; a Config-panel save (`threadConfigPatch` →
      `{ ...thread, config }`) leaves `thread.plan` intact, proven by a regression
      test.
      <!-- Updated: Red Team Session 1 - plan lives on ChatThread, not ThreadConfig -->
- [ ] A thread record written before this phase loads with no plan and no error.
- [ ] Plan caps and forbidden-key rules are enforced in one module, called by both
      `validateThread` and the tool, proven by tests on each path.
      <!-- Updated: Red Team Session 1 - single plan validation source -->
- [ ] The multi-tool acceptance turn passes: `search` → `read_file` → `edit_file`
      → `update_plan` → text, with every tool result an `ok` envelope and the file
      actually changed.
- [ ] All nine plan goals are demonstrated by at least one test each, and the
      goal-to-test mapping is recorded in the implementation log.
- [ ] `pnpm test`, `pnpm lint`, and `pnpm build` pass.
- [ ] Any gate that could not be verified automatically is named in `plan.md` with
      the reason, and is not claimed as met.
- [ ] `ak plan validate plans/260919-1821-harness-tools` exits 0.

## Risk Assessment

| Risk | Likelihood × impact | Mitigation |
|------|---------------------|------------|
| A plan write races the streaming run and is overwritten by a later `persist` | Medium × High | The write goes through `useChatStore.setThread`, and every persist reads the current store state (`src/chat/engine.ts:227`), so the plan survives. The engine test asserts the plan is present after the run settles. |
| A plan larger than 50 items bloats the thread record | Medium × Low | `MAX_PLAN_ITEMS` and `MAX_PLAN_TEXT_LENGTH` are enforced at validation and normalization, and rejected input never reaches persistence. |
| A Config-panel save drops the plan | High × High | The plan is a top-level `ChatThread` field, so a save that replaces only `config` preserves it. A regression test saves a config and asserts `thread.plan` is unchanged. This is why the plan is not on `ThreadConfig`. <!-- Updated: Red Team Session 1 - plan lives on ChatThread, not ThreadConfig --> |
| A malformed persisted plan makes a whole thread unloadable | Low × Medium | Validation is strict only for a present-and-malformed plan, and it is delegated to the single `src/chat/plan.ts` module, matching `validateThread`'s existing tolerant contract; the writer is the only producer and normalizes before writing. <!-- Updated: Red Team Session 1 - single plan validation source --> |
| The model rewrites a longer plan from a shorter one and loses items | Medium × Medium | Replace-all is stated in the tool description and asserted in a test; the tool returns the normalized list and counts so the model can confirm. |
| The e2e test becomes a brittle replay of SDK internals | Medium × Medium | It is reduced to the single cross-feature assertion no phase test makes, and asserts observable outcomes (envelope shapes, file content, persisted plan) rather than SDK call counts, reusing the existing `MockLanguageModelV4` helpers. <!-- Updated: Red Team Session 1 - e2e reduced to the cross-feature assertion --> |
| The UI panel drifts from the persisted shape | Low × Low | The panel reads the same validated top-level `ChatThread.plan`; there is no second model of the data. <!-- Updated: Red Team Session 1 - plan lives on ChatThread, not ThreadConfig --> |
| Reverting one phase late in the bundle leaves a half-integrated surface | Low × Medium | Each phase states its own rollback and none depends on a later phase; the e2e test is the bundle gate. |

**Rollback.** Revert this phase's files. The optional `plan` field disappears with no
data migration, and an existing record containing a plan still loads because the
validator for that field reverts with the code. Phases 1-5 remain independently
revertible.

## Security Considerations

- The plan is user-visible and model-authored. It is rendered as text in the panel;
  no HTML, link, or command from a plan item is executed or auto-linked.
- The plan never enters the system prompt, so a plan item cannot escalate itself into
  an instruction. The model sees it only as its own tool result.
- The write path reuses the existing encrypted thread persistence and the vault
  write queue, so no plaintext plan text appears in IndexedDB beyond what the
  existing envelope already encrypts. The existing byte-scan test covers thread
  records.
- `update_plan` cannot address another thread: the port is bound to the running
  thread's id at build time.
- The tool has no path, code, or network input, and declares no `code-runner`,
  `filesystem-write`, or `network` capability, so it adds no execution surface and the
  Phase 4 capability gate does not gate it.
  <!-- Updated: Red Team Session 1 - capability-based approval gating -->

## Next Steps

The controller runs the validation and red-team passes against this plan. The
implementation owner starts at Phase 1 and must not begin the Phase 4 body work
before the approval spike report exists.
