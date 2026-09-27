---
phase: 6
title: wait_agents
item: B1
status: completed
---

# Phase 6 — wait_agents

## Goal

The parent can fan out background agents and gather their results within the
same turn.

## Files

- Modify:
  - `src/agents/runtime.ts`: settle promises, `collected`, `wait`.
  - `src/agents/types.ts`: wait types, `BLOCKED_AGENT_TOOLS`.
  - `src/tools/types.ts`: `AgentSpawnPort.wait`.
  - `src/tools/builtin/agents.ts`: the tool and its view spec.
  - `src/session/session.ts`: `onSettle` skips notices for collected runs.
  - `src/components/assistant-ui/elements/tool-view/details/agents.tsx`: the
    view.
  - `src/tools/builtin/guides/agents.md`
  - Tests.

## Steps

1. The runtime keeps a settle promise per live run (`whenSettled(runId)`) and a
   `collected` set.
2. `wait(parent, { runIds?, labels?, mode = 'all' | 'any', timeoutMs = 300000
   (max 1800000) }, signal)`:
   - Resolve every target within the parent. An unknown or foreign target is an
     error.
   - Mark the running targets as collected.
   - Wait for all, or for any, or for the timeout, or for the turn's abort.
     Aborting stops the waiting only, never the runs.
   - Return per run `{ runId, label, status, result, structured?, filesChanged? }`.
     Runs still running at the end are listed as `running` and removed from
     `collected`, so their notice still arrives.
3. `onSettle` in the session skips the notice when `runtime.isCollected(runId)`,
   then clears the mark.
4. The tool view shows gathered runs as rows (status, label, open action) and
   the timed-out ones as still running.
5. The guide gains a fan-out/gather section: spawn N with `background: true`,
   then `wait_agents`.

## Tests (intent)

- `all` returns after the slowest run. `any` returns after the first run and
  lists the rest as running.
- On timeout, the settled runs come back with results, and the pending ones
  append their notice later.
- A collected run appends no notice.
- Aborting the parent turn resolves the wait and leaves the runs going.
- Waiting on another conversation's run is refused.
