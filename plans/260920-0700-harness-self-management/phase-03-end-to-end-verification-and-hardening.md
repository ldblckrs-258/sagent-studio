---
phase: 3
title: "End-to-End Verification and Hardening"
status: implemented
priority: P1
effort: "4h"
dependencies: [1, 2]
---

# Phase 3: End-to-End Verification and Hardening

## Context Links

- Plan: [`plan.md`](./plan.md) — acceptance criteria 1-9.
- Engine harness: `src/chat/harness-e2e.test.ts` (`MockLanguageModelV4`, the
  `tool-call` chunk, `createEngine`, `EngineDeps`).
- Provider tests: `src/tools/builtin/skill-management.test.ts`,
  `src/tools/builtin/tool-management.test.ts`, `src/tools/admin-ports.test.ts`.
- Store persistence pattern: `src/tools/store.test.ts:49-51` installs a real key
  from `deriveKey` after `vaultInternals.reset()`, backed by
  `fake-indexeddb/auto` (`src/test-setup.ts:1`). There is no
  `src/skills/store.test.ts`; use the tools-store test as the pattern and
  `skillStore` (`src/skills/store.ts:60`) as the dependency.
  <!-- Updated: Red Team Session 1 - removed nonexistent skills/store.test.ts -->
- Known pre-existing build blocker: `src/vault/UnlockScreen.tsx:81` passes an
  `InputHTMLAttributes` `size` (number) into the primitives `Input`
  (`src/ui/primitives.tsx:85`), whose `size` is `ControlSize`; `tsc -b` fails today
  independent of this plan.

## Goal

Prove the whole path works end to end and close the remaining edge and build gaps:
a model turn creates a skill and a tool that persist, re-hydrate after a reload,
respect the approval gate, and never touch a workspace skill, with the full suite,
lint, and build green.

## Requirements

- Extend `src/chat/harness-e2e.test.ts` to register
  `createSkillManagementProvider()` and `createToolManagementProvider()`, build the
  admin ports in the run's ports, and assert:
  - a mock model `tool-call` to `create_skill` returns an `ok` envelope and the
    `SkillRegistry` now lists the skill disabled;
  - a mock model `tool-call` to `create_tool` returns an `ok` envelope and the
    `ToolRegistry` lists it disabled;
  - `createToolApproval` marks `create_skill` / `create_tool` as `user-approval`
    in `editing` with an empty policy, as `approved` in `god` (still present), and
    the list tools are absent from the map in every mode.
    <!-- Updated: Red Team Session 1 - gated tools keep an 'approved' entry in god -->
- Assert the narrowing limitation: with one enabled skill whose `allowedTools` is
  `['read_file']`, the built tool set excludes `list_skills`/`create_skill` (they
  are subject to narrowing like any tool).
  <!-- Updated: Red Team Session 1 - narrowing dependency documented as behavior -->
- Assert `builtinProviders()` filtered through `isGatedTool` yields the six
  mutation names, which is what `ApprovalsPanel` renders
  (`src/ui/panels/approvals.tsx:22`).
  <!-- Updated: Red Team Session 1 - ApprovalsPanel consumer covered -->
- Create `src/tools/builtin/admin-persistence.test.ts` that installs a real vault
  key (pattern from `src/tools/store.test.ts:49-51`) and:
  - `createSkillAdminPort(new SkillRegistry(undefined, enablement))` creates a
    skill, then a **fresh registry with the same injected `SkillEnablementPort`**
    hydrates it disabled across the real `skillStore`. A bare `new SkillRegistry()`
    must NOT be used: without an enablement port, `hydrate` enables every stored
    manifest (`src/skills/registry.ts:170`), so the disabled-default assertion would
    be false.
    <!-- Updated: Red Team Session 1 - disabled default requires an enablement port -->
  - `createToolAdminPort(new ToolRegistry())` creates a `sandbox-js` and an `http`
    tool, then a fresh registry hydrates both across the real `toolStore`;
  - a rename through `update(from, definition)` leaves only the new name in the
    store and registry after re-hydration;
  - a create with `enabled: true` whose enablement write is forced to fail reports
    `enabled: false` and re-hydrates disabled;
  - a byte-scan of the raw store rows contains neither the skill instructions
    marker nor the tool description marker.
  <!-- Updated: Validation Session 1 - rename and enablement reconcile verified -->
- Add the remaining edge cases if not already covered by Phase 1 tests:
  - duplicate skill id against a workspace skill returns `conflict`;
  - `update_skill` with no patch fields returns `invalid_input`;
  - `create_tool` with a builtin name returns `conflict` and writes nothing;
  - `update_tool` on an unknown name returns `not_found`.
- Fix the pre-existing `src/vault/UnlockScreen.tsx:81` `Input` `size` type
  conflict so `pnpm build` passes. The minimal fix is to stop spreading the
  numeric HTML `size` attribute into the primitives `Input` (omit `size` from the
  forwarded props, as `PasswordInput` does not need it), leaving runtime behavior
  unchanged.
- Run the full gates: `pnpm test`, `pnpm lint`, `pnpm build`.

## Architecture

```
harness-e2e
  model tool-call create_skill ─▶ provider ─▶ SkillAdminPort ─▶ SkillRegistry
  model tool-call create_tool  ─▶ provider ─▶ ToolAdminPort  ─▶ toolStore + ToolRegistry
  createToolApproval(editing, {}, [...]).create_skill === 'user-approval'

admin-persistence
  keyring.install(deriveKey(...))
  port.create(...) ─▶ encrypted skillStore/toolStore ─▶ raw byte scan
  new SkillRegistry().hydrate() ─▶ skill present, disabled
```

## Files to Create / Modify

Create:

- `src/tools/builtin/admin-persistence.test.ts`

Modify:

- `src/chat/harness-e2e.test.ts` — providers, admin ports, and end-to-end cases.
- `src/tools/builtin/skill-management.test.ts` — workspace-conflict and empty-patch
  cases if missing.
- `src/tools/builtin/tool-management.test.ts` — builtin-conflict and unknown-name
  cases if missing.
- `src/vault/UnlockScreen.tsx` — resolve the pre-existing `Input` `size` type
  conflict.

Do not modify: `src/tools/approval.ts`, `src/tools/types.ts`, `src/skills/**`,
`src/tools/store.ts`, `src/skills/store.ts`.

## Test Plan

Integration — `src/chat/harness-e2e.test.ts`

- A `create_skill` tool call from the mock model persists a vault skill and returns
  `ok`.
- A `create_tool` tool call persists an `http` user tool and returns `ok`.
- The approval map built for the run contains `create_skill` and `create_tool` in
  `editing` and omits `list_skills` / `list_user_tools`.

Integration — `src/tools/builtin/admin-persistence.test.ts`

- Skill and tool created through the admin ports re-hydrate in a fresh registry.
- Raw IndexedDB bytes contain no plaintext marker from the skill instructions or
  the tool description.

Regression

- All prior suites pass; `pnpm build` now succeeds.

## Implementation Steps

1. Add the two providers and the admin ports to the harness-e2e setup; write the
   three end-to-end cases.
2. Write `admin-persistence.test.ts` with the keyring pattern and the byte scan.
3. Fill any missing edge cases in the two provider suites.
4. Fix the `UnlockScreen` `Input` `size` conflict and confirm `pnpm build` is green.
5. Run `pnpm test`, then `pnpm lint` and `pnpm build`. Record the observed result.

## Todo

- [x] Harness end-to-end create_skill / create_tool cases
- [x] Approval-map assertion for the new tools
- [x] `admin-persistence.test.ts` round-trip and byte scan
- [x] Edge cases (workspace conflict, empty patch, builtin conflict, unknown name)
- [x] Pre-existing `UnlockScreen` build error fixed
- [x] `pnpm test`, `pnpm lint`, `pnpm build` green

## Success Criteria

- [x] A model-created skill and tool persist and re-hydrate after reload, proven by
      `admin-persistence.test.ts`.
- [x] No plaintext skill instructions or tool description appear in IndexedDB,
      proven by the byte scan.
- [x] The mutation tools appear in the approval map and the list tools do not.
- [x] `pnpm test`, `pnpm lint`, and `pnpm build` pass.

## Risk Assessment

| Risk | Likelihood × impact | Mitigation |
|------|---------------------|------------|
| Mock model tool-call plumbing differs from the plan's approval expectation | Medium × Medium | Reuse the existing `tool-call` chunk shape in `harness-e2e.test.ts`; the `toolNamesOf` helper lives in `src/chat/engine.test.ts:233`. Assert on the approval map directly rather than through the UI. <!-- Updated: Red Team Session 1 - corrected nonexistent symbol/phase references --> |
| Real-keyring persistence test interferes with other suites | Low × Medium | Follow the `vaultInternals.reset()` + `keyring.install` pattern used by `src/tools/store.test.ts:49`. |
| The `UnlockScreen` fix changes runtime layout | Low × Low | The fix only stops forwarding a numeric `size`; no visual input uses it. `pnpm test`/`lint`/`build` confirm. |
| `pnpm build` reveals additional pre-existing type errors | Medium × Medium | Fix only errors proven unrelated to this plan, each as a minimal type-only change; record any that require product input instead of guessing. |

**Rollback.** Revert the phase's test files and the one-line `UnlockScreen` fix.
The implementation phases are untouched.

## Security Considerations

- The byte-scan test proves the new artifacts stay encrypted and that no plaintext
  leaks into IndexedDB.
- The end-to-end test asserts the mutation tools are gated and the list tools are
  not, protecting the `write_file`-parity decision.

## Next Steps

The plan is complete. Hand off to `/ak:cook {plan-dir}/plan.md` for sequential
implementation.
