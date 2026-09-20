---
phase: 2
title: "Live Panel Refresh"
status: implemented
priority: P2
effort: "4h"
dependencies: [1]
---

# Phase 2: Live Panel Refresh

## Context Links

- Plan: [`plan.md`](./plan.md) — goal 6; Key Decision "Registry change notification".
- Registries: `src/skills/registry.ts:20` (`SkillRegistry`), `src/tools/registry.ts:31`
  (`ToolRegistry`).
- Panels: `src/ui/panels/skills.tsx:40` (local `version` state at `:43`),
  `src/ui/panels/tools.tsx` (local `version` state and `setVersion` calls).
- React external-store seam: `useSyncExternalStore` (React 19, already a
  dependency).

## Goal

Make model-driven skill and tool mutations visible immediately: both panels
re-render when a registry changes, whether the change came from the panel or from
a model tool call inside a turn.

## Requirements

- `SkillRegistry` and `ToolRegistry` each gain an identical, minimal observer:
  ```ts
  subscribe(listener: () => void): () => void
  getVersion(): number
  ```
  and a private `notify()` that increments the version and invokes every listener.
  Listeners are held in a `Set`; `subscribe` returns an unsubscribe function.
- `SkillRegistry.notify()` is called from `register`, **`updateSkill`**,
  `setEnabled`, and `removeSkill`. `updateSkill` mutates the map directly
  (`src/skills/registry.ts:136`) and does **not** route through `register`, so it
  must notify explicitly. `importSkill`, `loadWorkspaceSkills`, and `hydrate` go
  through `register` and are covered.
  <!-- Updated: Red Team Session 1 - updateSkill bypasses register; notify explicitly -->
- `ToolRegistry.notify()` is called from `registerProvider`, `registerUserTool`,
  `replaceUserTool`, `setEnabled`, and `removeUserTool`.
- No subscriber list leaks: a panel that unmounts unsubscribes.
- Create `src/ui/use-registry-version.ts`:
  ```ts
  export function useRegistryVersion(registry: {
    subscribe(listener: () => void): () => void
    getVersion(): number
  }): number
  ```
  implemented with `useSyncExternalStore`, memoizing `subscribe` and
  `getSnapshot` on the registry identity so a session swap re-subscribes cleanly.
- `src/ui/panels/skills.tsx` and `src/ui/panels/tools.tsx` replace the local
  `version` counter with `useRegistryVersion(session.skillRegistry)` /
  `useRegistryVersion(session.toolRegistry)`. The `data-skills-version` /
  `data-tools-version` attributes keep working (they now carry the registry
  version), and the redundant `setVersion(...)` calls are removed.
- The panels remain display-only: mutating through a panel still goes through the
  same registry methods, which now notify, so local edits and model edits use one
  refresh path.

## Architecture

```
model tool call (turn)
  → SkillAdminPort.create → SkillRegistry.register → notify()
  → ToolAdminPort.create  → ToolRegistry.registerUserTool → notify()
                                          │
                    useSyncExternalStore(subscribe, getVersion)
                                          │
                    SkillsPanel / ToolsPanel re-render
```

**Why not zustand.** The registries are per-session class instances owned by
`createSession` (`src/session/session.ts:103`), not global stores. A local observer
keeps the layering intact and avoids importing the chat store into the tools layer.

## Files to Create / Modify

Create:

- `src/ui/use-registry-version.ts`

Modify:

- `src/skills/registry.ts` — `subscribe`, `getVersion`, `notify` calls.
- `src/tools/registry.ts` — same.
- `src/skills/registry.test.ts` — observer cases.
- `src/tools/registry.test.ts` — observer cases.
- `src/ui/panels/skills.tsx` — consume `useRegistryVersion`.
- `src/ui/panels/tools.tsx` — consume `useRegistryVersion`.

Do not modify: `src/tools/builtin/**`, `src/tools/types.ts`, `src/tools/approval.ts`,
`src/chat/**`, `src/vault/**`.

## Test Plan

Unit — `src/skills/registry.test.ts`

- `getVersion()` increases after `register`, **`updateSkill`**, `setEnabled`, and
  `removeSkill`.
  <!-- Updated: Red Team Session 1 - updateSkill must notify -->
- `subscribe` fires on each mutation and the returned unsubscribe stops delivery.
- Two listeners both fire; unsubscribing one leaves the other active.

Unit — `src/tools/registry.test.ts`

- `getVersion()` increases after `registerProvider`, `registerUserTool`,
  `replaceUserTool`, `setEnabled`, and `removeUserTool`.
- `subscribe`/unsubscribe behavior matches the skill registry.

Regression

- `src/session/session.test.ts`, `src/chat/harness-e2e.test.ts`, and
  `src/tools/registry.test.ts` pass; the observer is additive and never changes
  tool availability.

## Implementation Steps

1. Add `listeners`, `version`, `subscribe`, `getVersion`, and `notify` to
   `SkillRegistry`; call `notify` in `register`, `updateSkill`, `setEnabled`,
   `removeSkill`.
   <!-- Updated: Red Team Session 1 - updateSkill must notify -->
2. Add the same to `ToolRegistry`; call `notify` in `registerProvider`,
   `registerUserTool`, `replaceUserTool`, `setEnabled`, `removeUserTool`.
3. Extend both registry test suites with version and subscription cases.
4. Write `src/ui/use-registry-version.ts`.
5. Swap local `version` state for `useRegistryVersion` in both panels and delete
   the now-redundant `setVersion` calls.
6. Run `pnpm test`, then `pnpm lint` and `pnpm build`.

## Todo

- [x] `SkillRegistry.subscribe` / `getVersion` / `notify` (including `updateSkill`)
- [x] `ToolRegistry.subscribe` / `getVersion` / `notify`
- [x] Registry observer tests
- [x] `useRegistryVersion` hook
- [x] Both panels consume the hook; local `version` state removed
- [x] `pnpm test`, `pnpm lint`, `pnpm build` green

## Success Criteria

- [x] A registry mutation notifies every subscriber exactly once per mutation.
- [x] `getVersion` is monotonic and drives `useSyncExternalStore`.
- [x] Both panels render the current registry contents after a model-driven
      mutation without a manual refresh.
- [x] No `setVersion` remains in either panel; the `data-*-version` attributes are
      still present.
- [x] `pnpm test`, `pnpm lint`, and `pnpm build` pass.

## Risk Assessment

| Risk | Likelihood × impact | Mitigation |
|------|---------------------|------------|
| `useSyncExternalStore` gets a new `getSnapshot` identity each render and loops | Medium × High | `getSnapshot` returns `registry.getVersion()`, a primitive; `subscribe`/`getSnapshot` are memoized on registry identity. Tests plus a manual panel check. |
| Hydration emits once per skill and thrashes the panel | Low × Low | Hydration happens at unlock before panels mount; the notify cost is a version increment. |
| A panel subscribes to a stale registry after a vault relock | Medium × Medium | The hook's memo keys on the registry instance; `createSession` builds a new registry per unlock, so the effect re-subscribes. |

**Rollback.** Revert the phase's files. The registries return to their previous
shape and the panels return to local `version` counters; model mutations are then
only visible after a panel remount, which is the pre-phase behavior.

## Security Considerations

- The observer carries no data and exposes no new mutation path.
- Panels remain display-only; all writes still pass through the registry methods
  and, for model calls, the approval gate.

## Next Steps

Phase 3 exercises the full path end to end: a model turn creates a skill and a
tool, the panel reflects it, a reload re-hydrates it, and the whole suite, lint,
and build pass.
