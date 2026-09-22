---
phase: 3
title: "Agent runtime core"
status: completed
priority: P1
effort: 2d
dependencies: [1]
---

# Phase 3: Agent runtime core

## Overview

Build the reusable engine that runs one nested agent: clamp the requested mode
to the parent's, resolve the toolset the sub-agent may use, pick the model from
the requested tier, run a bounded `streamText` step loop, and pause on
consent-requiring tools through an approval queue. This module knows nothing
about the `spawn_agent` tool or the UI; it is pure orchestration.

## Key Insights

- **Approval uses the SDK's async `toolApproval`, not `execute` wrapping.**
  `SingleToolApprovalFunction` returns `MaybePromiseLike<ToolApprovalStatus>`
  (`node_modules/ai/dist/index.d.ts:3111`, `:3050-3057`), so a generic
  `toolApproval` can `await` the approval queue and resolve to `'approved'` or
  `'denied'` inline. No `approval-requested` message part and no resume path are
  needed, which is exactly why await and background agents can share one code
  path. Do not rewrite tool `execute` functions.
- **One shared toolset resolver.** `buildRunStream` (`src/chat/engine.ts:350-369`)
  already computes the skill-narrowed, always-kept tool list. Extract it into a
  single helper with a `blocked` argument so the parent (blocked = none) and the
  sub-agent (blocked = one-level + parent-thread mutators) cannot drift. The
  sub-agent's block filter MUST be applied **after** the skill union.
- **Skill narrowing fails open.** `toolNamesFor` returns `undefined` when
  `resolve` yields nothing (`src/skills/registry.ts:140-161`), and `resolve`
  silently drops disabled or unknown refs (`:117-138`). For a sub-agent, an
  explicitly requested skill that does not resolve must be a hard error, not a
  silent widening to the full pool.
- **`allowedTools` is unvalidated free text** (`src/skills/schema.ts:8,43-44`),
  so a skill can name `change_mode`/`spawn_agent`. The block filter after the
  union neutralizes this, which is why block order matters.
- `modeCeiling`/`isWithinCeiling` (`src/tools/approval.ts:136-146`) encode the
  three modes; for a sub-agent the mode is a hard cap, so build the toolset from
  `isWithinCeiling(effectiveMode, { name, kind })` using
  `toolRegistry.userToolKind`, never by listing above-ceiling tools.
- **Blocked for sub-agents:** `spawn_agent` (one level deep), `change_mode`
  (would mutate the parent thread's mode), `update_plan` (would clobber the
  parent plan), and `restore` (reverts the *parent's* shared journal).

## Requirements

- `MODE_ORDER`, `modeRank(mode)`, `clampMode(parent, requested)` in
  `src/tools/approval.ts` (`read_only < editing < god`).
- One shared `resolveRunToolNames` used by both `buildRunStream` and the runner,
  with blocks subtracted last.
- `resolveAgentToolNames` clamps the mode, requires every requested skill to
  resolve, subtracts `excludeTools` and `BLOCKED_AGENT_TOOLS`, and returns the
  final names.
- `runAgent(context, deps, signal, onEvent)` runs a bounded step loop and returns
  a structured result; it never throws into the caller and never leaves the queue
  unsettled.
- `AgentApprovalQueue` with `request`, `pending`, `resolve`, `settleAll`, and a
  `signal`; abort settles every pending request as denied. Delegated approvals
  are Allow/Deny only: no `allow-always`, so a sub-agent cannot durably weaken
  the parent's persisted policy.
- The runtime owns one AbortController per run and registers a global abort so a
  vault lock, `disposeThread`, or `dispose` stops every detached run.
- Caps: a global concurrent-agent cap and a per-thread cap, counting awaited
  runs, plus `MAX_AGENT_STEPS` and `MAX_AGENT_OUTPUT_CHARS`.

## Related Code Files

- Modify: `src/tools/approval.ts` (mode ordering helpers)
- Create: `src/tools/selection.ts` (shared tool-name resolver)
- Create: `src/tools/selection.test.ts`
- Modify: `src/chat/engine.ts` (use the shared resolver; no behavior change)
- Create: `src/agents/types.ts`
- Create: `src/agents/toolset.ts`
- Create: `src/agents/toolset.test.ts`
- Create: `src/agents/approval-queue.ts`
- Create: `src/agents/approval-queue.test.ts`
- Create: `src/agents/runner.ts`
- Create: `src/agents/runner.test.ts`

## Implementation Steps

1. In `src/tools/approval.ts` export `MODE_ORDER`, `modeRank`, and `clampMode`.
2. Extract the tool-list computation from `buildRunStream` into a shared
   `src/tools/selection.ts` `resolveRunToolNames({ registry, ports, skills, blocked })`,
   returning the union of skill-narrowed names and the always-kept
   skill-index/guide tools, then subtracting `blocked`. Have `buildRunStream`
   call it with `blocked: []` and the sub-agent runner call it with
   `BLOCKED_AGENT_TOOLS`.
3. `src/agents/types.ts` defines `AgentRequest`, `AgentParentContext`,
   `AgentRunResult`, `AgentRunEvent`, and
   `BLOCKED_AGENT_TOOLS = ['spawn_agent', 'change_mode', 'update_plan', 'restore']`.
4. `src/agents/toolset.ts` implements `resolveAgentToolNames`: clamp the mode;
   resolve requested skill ids to refs (vault preferred when an id exists in both
   sources) and fail `invalid_input` when any id does not resolve; call
   `resolveRunToolNames` with the parent context's narrowed names as the pool;
   filter with `isWithinCeiling`; subtract `excludeTools` and blocks last.
5. `src/agents/approval-queue.ts` implements `createApprovalQueue({ signal })`:
   `request` mints an id, records `{ id, runId, toolName, input, createdAt }`,
   notifies subscribers, and returns a promise; `resolve(id, allowed)` resolves
   it; `settleAll(false)` rejects every pending request when the signal aborts or
   the runtime is torn down. No persistence callback.
6. `src/agents/runner.ts` implements `runAgent`:
   - resolve the model from the tier via `createTierModel(settings, tier, modelFactory)`
     and fall back to the parent's `modelFactory(settings, providerId, modelId)`;
   - build the toolset from `resolveAgentToolNames` via `toolRegistry.buildToolSet`;
   - pass a generic async `toolApproval` that maps `resolveApprovalStatus` to
     `approved`/`denied`, and for `user-approval` emits an `approval-requested`
     event and awaits `queue.request`;
   - compose the prompt with `composeSystemPrompt(prompt, skills, names, { mode })`;
   - `streamText` with `stopWhen: stepCountIs(MAX_AGENT_STEPS)` and the run's
     abort signal; iterate the full stream to emit events; collect text, tool
     calls, and usage; catch abort/error into `stopReason`.
7. Export `MAX_AGENT_STEPS`, `MAX_AGENT_OUTPUT_CHARS`, `MAX_CONCURRENT_AGENTS`,
   `MAX_AGENTS_PER_THREAD`, and `summarizeAgentResult(result)`.
8. Tests: `toolset.test.ts` table-drives the ceiling, exclusions, skill-miss
   error, and asserts `restore`/`change_mode`/`update_plan`/`spawn_agent` are
   absent even when a skill's `allowedTools` names them. `approval-queue.test.ts`
   covers request/resolve and abort `settleAll`. `runner.test.ts` uses injected
   mock models (distinct from the parent's) to assert tool execution, denial
   short-circuit, abort settling pending approvals, and the step cap.

## Todo

- [x] `modeRank`/`clampMode` in `tools/approval.ts`
- [x] Shared `resolveRunToolNames` extracted and used by `buildRunStream`
- [x] Agent types + `BLOCKED_AGENT_TOOLS` (incl. `restore`)
- [x] `resolveAgentToolNames` with mode clamp, skill-miss error, blocks last
- [x] `AgentApprovalQueue` with abort `settleAll`, no allow-always
- [x] `runAgent` async `toolApproval` loop + model fallback + events
- [x] Abort lifecycle: per-run controller registered with global abort
- [x] Unit tests for toolset, queue, and runner

## Success Criteria

- `pnpm test src/agents` passes.
- A requested mode above the parent's is clamped, and above-ceiling tools are
  absent.
- A skill requesting a blocked tool cannot re-add it.
- An unknown requested skill returns `invalid_input` instead of widening the
  toolset.
- Aborting a run settles every pending approval and the run promise.
- `pnpm build` (tsc) and `pnpm lint` pass.

## Risk Assessment

- **SDK contract:** confirm the async generic `toolApproval` resolves inline
  against `ai@7` before committing; keep the queue API decoupled so a fallback to
  per-tool `needsApproval` is contained.
- **Runaway cost:** caps are per-session (global) and per-thread, count awaited
  runs, and bound steps/output.
- **Approval deadlock:** queue settles on abort; the runtime's controller is
  registered with the global abort list so lock/teardown always reaches it.

## Security Considerations

- The clamp and toolset filter are the boundary; derive classification from
  descriptor `kind`, and subtract blocks after the skill union.
- Delegated approvals never persist; the parent's `approvals` policy is only read.
- Sub-agents act only through existing ports and never touch `src/vault` directly.

## Next Steps

- Phase 4 exposes this engine through `spawn_agent` and owns run lifecycle,
  background notices, and reload reconciliation.
