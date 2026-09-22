---
phase: 6
title: "Docs and end-to-end verification"
status: completed
priority: P2
effort: 0.5d
dependencies: [2, 5]
---

# Phase 6: Docs and end-to-end verification

## Overview

Document the delegation feature and the model tiers for users, and prove the
whole path end to end: a parent model calls `spawn_agent` through the real
engine, a sub-agent runs on a tier model, and a background run delivers a notice
into the parent thread.

## Key Insights

- The README is the user-facing contract for modes, models, and data egress. New
  user-visible behavior (tiers, delegation, background agents, last-used model)
  belongs there; internal module notes do not.
- `harness-e2e.test.ts` already exercises the engine with
  `MockLanguageModelV4`; extend that pattern rather than inventing a new harness.
- The default `pnpm test` glob runs every `*.test.ts`, so the new suites are
  covered once they exist; the phase's job is the end-to-end flow and the docs.

## Requirements

- README: a short "Delegating work to sub-agents" section and an updated model
  configuration paragraph (tiers + last-used model + cheap-tier migration).
- An end-to-end test that: creates an engine with the agent runtime wired,
  streams a parent turn whose model calls `spawn_agent`, and asserts the sub-agent
  result reaches the parent; and a second case asserting a background run appends
  a notice after settling.
- Full verification commands recorded in the phase.

## Related Code Files

- Modify: `README.md`
- Create: `src/agents/agent-e2e.test.ts`
- Modify: `src/chat/harness-e2e.test.ts` (only if a shared helper is needed)

## Implementation Steps

1. Add a README section explaining delegation: what the model may delegate, that
   the requested mode is capped by the conversation mode, that background agents
   surface in the Agents panel and report back as a notice, and that delegation
   is one level deep.
2. Update the README model paragraph: the four tiers with their display names, the
   cheap tier taking over the old sub-model duties, and the last-used model
   seeding new conversations.
3. Write `src/agents/agent-e2e.test.ts` using injected mock models (a distinct
   sub-model instance, not the parent's): a parent stream that emits a
   `spawn_agent` tool call, a sub-agent model stream that replies, and assertions on the
   parent tool result; a background case that awaits the settle callback and
   asserts exactly one notice; an explicit `tier: 'max'` case asserting the
   advisory tier model is used; and a reconciliation case asserting a persisted
   `running` delegation rehydrates as `interrupted`.
4. Run the full gate and fix fallout: `pnpm test`, `pnpm lint`, `pnpm build`.

## Todo

- [x] README delegation section
- [x] README model/tier + last-used-model update
- [x] End-to-end await agent test
- [x] End-to-end background agent notice test
- [x] `pnpm test` / `pnpm lint` / `pnpm build` green

## Success Criteria

- `pnpm test` passes across the whole suite.
- `pnpm lint` passes.
- `pnpm build` (type-check + Vite build) succeeds.
- README describes the shipped behavior with no mention of the removed
  `sub-model` setting.

## Risk Assessment

- **Test flakiness:** background completion is asynchronous; await the settle
  promise rather than polling timers.
- **Docs drift:** describe only behavior proven by the tests in this phase.

## Security Considerations

- README must state plainly that sub-agents talk to the same configured provider
  and add no new egress, and that background runs are abortable and cleared on
  vault lock.

## Next Steps

- None; this phase closes the plan. Run `/ak:cook` phase by phase and archive the
  plan when the gate is green.
