---
phase: 3
title: "Agent control tools: stop_agent and read_agent"
status: completed
priority: P1
effort: 1d
dependencies: [2]
---

# Phase 3: Agent control tools: stop_agent and read_agent

## Goal

Let the main model stop a delegated agent and read its recent turns, through two
new built-in tools backed by the parent-scoped agent port.

## Overview

`createAgentsToolProvider` currently exposes only `spawn_agent`. Add `stop_agent`
and `read_agent`, resolve their identifiers (`runId` or `label`), and return
structured results. `read_agent` returns the last N text turns, optionally with
tool calls, and is bounded so it cannot flood the parent context.

## Key Insights

- **Identifiers are not unique.** `runId` is exact; `label` is a user-facing
  string that may repeat. Resolve `label` only when it matches exactly one live
  or persisted run for the parent; otherwise return a clear `invalid_input`.
- **Tool results are untrusted.** Sub-agent text returned by `read_agent` is the
  same untrusted model output as `spawn_agent`; mark it `untrusted: true`.
- **Token bound.** `lastN` is clamped (1..50, default 6) and each turn is
  truncated to a fixed character cap, mirroring `MAX_AGENT_OUTPUT_CHARS`.
- **Same provider, same block list.** These tools exist only on the parent
  (`BLOCKED_AGENT_TOOLS` keeps `spawn_agent` and the new control tools out of a
  sub-agent's toolset; add `stop_agent` and `read_agent` to the block list so a
  child cannot control siblings).

## Requirements

- `NAMES = ['spawn_agent', 'stop_agent', 'read_agent']` in
  `src/tools/builtin/agents.ts`.
- `stop_agent` input `{ runId?: string; label?: string }`; stops one run, or
  every running run of the parent when neither is given only if that is explicit
  in the description. Prefer requiring one identifier to avoid surprises.
- `read_agent` input `{ runId?: string; label?: string; lastN?: number;
  includeTools?: boolean }`.
- Both return `toolOk` with the resolved `runId`, status, and reason where
  applicable; failures return `toolFail('invalid_input' | 'runtime_error', ...)`.
- `BLOCKED_AGENT_TOOLS` in `src/agents/types.ts` gains `stop_agent` and
  `read_agent`.
- The agents tool guide documents when the parent should stop or read a child.

## Files to Create / Modify

- Modify: `src/tools/builtin/agents.ts`
- Modify: `src/tools/builtin/agents.test.ts`
- Modify: `src/agents/types.ts` (`BLOCKED_AGENT_TOOLS`)
- Modify: `src/agents/toolset.test.ts` (blocked list assertion)
- Modify: `src/tools/builtin/guides/agents.md`
- Modify: `src/tools/builtin/tool-guide.test.ts` if it asserts the guide index

## Implementation Steps

1. Extend `NAMES` and the `create(name, ports)` switch with `stop_agent` and
   `read_agent`.
2. Add identifier resolution that prefers `runId` and otherwise matches a unique
   `label` via `ports.agents.resolveRun`; an ambiguous or missing match returns
   `toolFail('invalid_input', ...)`.
3. Implement `stop_agent` `execute`: resolve the run, call `ports.agents.stop`,
   and return `{ runId, stopped: true, reason: 'user_stop' }` or a failure.
4. Implement `read_agent` `execute`: parse `lastN` and `includeTools`, call
   `ports.agents.read`, and return `{ runId, status, turns, untrusted: true }`
   with each turn truncated.
5. Add `stop_agent` and `read_agent` to `BLOCKED_AGENT_TOOLS`.
6. Update `guides/agents.md` with a short "Stopping and reading a child" section.
7. Tests: `agents.test.ts` covers schema validation, unique-label resolution,
   ambiguous-label rejection, stop result, and `lastN` clamping/truncation.

## Verification

- `pnpm test src/tools/builtin/agents.test.ts src/agents/toolset.test.ts`
- `pnpm lint && pnpm build`

## Success Criteria

- The model can stop a specific child and read its last N turns.
- Ambiguous labels fail safely instead of guessing.
- A sub-agent's toolset never contains `stop_agent` or `read_agent`.

## Risk Assessment

- **Identifier ambiguity:** resolve-then-fail is required; never stop/read a
  guessed run.
- **Read amplification:** clamp `lastN` and truncate per turn so a large child
  transcript cannot blow the parent's context budget.

## Security Considerations

- Both tools are parent-scoped and enforce ownership in the runtime; the label
  resolver only searches the calling parent's runs.
- Read output is untrusted and flagged as such for the transcript UI.

## Next Steps

- Phase 4 improves how these results and reports render.
