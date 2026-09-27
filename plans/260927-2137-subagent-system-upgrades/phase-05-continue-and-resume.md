---
phase: 5
title: Continue and resume runs
item: B3
status: completed
---

# Phase 5 — Continue and resume runs

## Goal

A finished, stopped, or interrupted run can be picked up again with its own
history, by the user from the run view or by the parent model with
`message_agent`, including after a reload.

## Files

- Modify:
  - `src/agents/types.ts`: `RunSpec`, `message_agent` port types.
  - `src/agents/runtime.ts`: `continue`.
  - `src/agents/runner.ts`: a seed history.
  - `src/agents/run-transcript.ts`: pass index offset.
  - `src/agents/store.ts`
  - `src/chat/types.ts` and `src/chat/persistence.ts`: `AgentThreadMeta.spec`,
    read tolerantly.
  - `src/session/session.ts`: `continueAgentRun`, a parent context for UI
    continues, `createAgentPorts`.
  - `src/tools/types.ts`: `AgentSpawnPort.continue`.
  - `src/tools/builtin/agents.ts`: the `message_agent` tool.
  - `src/agents/types.ts`: `BLOCKED_AGENT_TOOLS`.
  - `src/ui/agent-run-view.tsx`, `src/ui/steer-composer.tsx`
  - Tests.

## Steps

1. `RunSpec = { profile?, skills?, excludeTools?, outputSchema?, toolNames,
   providerId, modelId? }` records the parent tool pool at spawn time. It is
   stored on the record, the snapshot, and `AgentThreadMeta.spec`. Old threads
   without it can be read but not continued, and the UI says why.
2. The runner accepts `seed?: { messages: UIMessage[]; history: ModelMessage[] }`:
   - The transcript starts from `seed.messages`, and new passes are appended
     with ids offset past the existing ones.
   - `history` starts from `seed.history`.
3. `runtime.continue(parent, runId, text, { background })`:
   - Refuse a running run; use `steer` for that.
   - Enforce the concurrency and per-thread limits.
   - Load the live record, or else the persisted snapshot.
   - Rebuild the toolset from the spec, clamping the mode to the parent's
     current mode.
   - `history = convertToModelMessages(messages, { tools, ignoreIncompleteToolCalls: true })`
     plus the user turn.
   - Set the status back to `running` and clear `endedAt` and `result`. Settle
     the same way a spawn does: persist, notify, and send a notice when
     detached.
4. The `message_agent({ runId | label, message, background? })` tool:
   - A running run is steered and the tool returns `{ delivered: 'steer' }`.
   - A settled run is continued. When awaited it returns a result shaped like
     `spawn_agent`'s; with `background` it returns `{ status: 'running', runId }`.
   - It is blocked for children.
5. Run view:
   - When the run is settled and continuable, the composer is open with the
     placeholder "Continue the agent…". Send calls `session.continueAgentRun`.
   - Interrupted and stopped runs show a **Resume** action that sends "Continue
     where you left off."
   - Non-continuable runs (legacy, no spec) keep the composer closed with the
     reason.
6. The session builds the parent context for a UI continue from the parent
   thread's current config and mode.

## Tests (intent)

- Continuing a completed run:
  - the model's prompt contains the earlier assistant text and tool results;
  - the transcript gains a user turn and a new assistant turn;
  - ids are unique;
  - the status goes running, then completed.
- A run that exists only in persistence (simulated reload) can be continued.
- The per-thread limit applies to continues.
- A lowered parent mode clamps the continued run.
- `message_agent` on a running run steers; on a settled run it continues.
- A legacy run without a spec is refused with a clear message.
