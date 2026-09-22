---
phase: 4
title: "spawn_agent tool and background notices"
status: completed
priority: P1
effort: 1.5d
dependencies: [3]
---

# Phase 4: spawn_agent tool and background notices

## Overview

Expose the agent runtime to the model as `spawn_agent`, wire it into the engine's
per-run ports, own the lifecycle of detached runs, and deliver a background
agent's result to the parent conversation as an appended notice. Await agents
return their result inline; background agents return a run handle immediately and
report back once. Every run persists as a **child agent thread** so its
transcript survives a reload.

## Key Insights

- **Availability is not the parent tool list.** `buildToolSet` calls
  `availableNames(ports)` → `isAvailable(ports)` (`src/tools/registry.ts:129-138`)
  before the toolset exists, so the `agents` port cannot depend on
  `Object.keys(toolSet)`. Make the port hold a mutable parent context: create it
  before `buildToolSet`, then assign `context.toolNames = Object.keys(toolSet)`
  after. `spawn_agent` reports `isAvailable: () => true`; its `execute` throws
  `ToolRuntimeUnavailableError` when no port is attached, so it still appears in
  the Tools panel and is introspectable.
- **Two `buildRunStream` callers.** `src/chat/engine.ts:873` (the real engine)
  and `src/chat/transport.ts:14` (legacy transport). Pass the parent thread
  context as a new optional final argument; `transport.ts` needs no change and
  simply has no agents port.
- **One report path per mode.** Await returns the result as the tool result;
  background appends exactly one notice on settle. `onSettle` must be wired for
  background runs only.
- **Detached runs need an owner.** `abortAll` only reaches controllers registered
  via `registerAbortAll` (`src/chat/store.ts:151-162`), `disposeThread` only
  aborts that thread's engine (`src/session/session.ts:313-318`), and
  `deleteConversation` drops the journal slot (`src/chat/threads.ts:94-100`). The
  agent runtime must own per-run controllers, register a global abort, and abort
  by thread id from `disposeThread`/`dispose`/lock; the settle callback must drop
  notices for a thread that no longer exists.
- **Notices must not race a run or a compaction.** Both `startRun` and manual
  `compact` register a per-thread controller (`src/chat/engine.ts:610-642`,
  `:770-772`), and only `startRun`'s `finally` flushes today. Key the notice
  queue on an explicit per-thread in-flight count so every controller-releasing
  `finally` flushes it.
- **Runs are persisted child threads.** Reuse the encrypted `db.threads` store:
  mark an agent thread with an `agent` metadata block and exclude it from the
  conversations list. A throttled save during streaming plus a final save on
  settle gives a transcript that survives reload; `listAgentRuns(parentThreadId)`
  feeds the panel. On rehydrate, any child still `running` becomes `interrupted`,
  and the parent's matching `spawn_agent` result is rewritten from `running` to
  `interrupted`, so a reload never leaves a phantom. `deleteConversation`
  cascades to its child runs.
- Sub-agent output is derived from untrusted workspace/library content, so the
  parent context must mark it as untrusted.

## Requirements

- `spawn_agent` schema: `prompt` (required), `mode?`, `tier?` (`cheap|medium|high|max`),
  `skills?` (skill ids), `excludeTools?`, `background?`, `label?`.
- Defaults: `mode` → `read_only`; `tier` → `tierForMode(mode)`
  (`read_only→cheap`, `editing→medium`, `god→high`); `max` is explicit-only for
  advisory/planning delegations; `background` → `false`.
- Await: the sub-agent result inline, clamped to `MAX_AGENT_OUTPUT_CHARS`, marked
  untrusted. Background: `{ status: 'running', runId, label }`, one notice on
  settle.
- Caps enforced across the session: `MAX_CONCURRENT_AGENTS` globally and
  `MAX_AGENTS_PER_THREAD` per parent thread, counting awaited runs; over-limit
  returns `limit_exceeded`.
- Every run is persisted as a child agent thread (mode, tier, label, status,
  messages) that survives reload; a `running` child found on reload reconciles to
  `interrupted`.
- An `agents` tool guide documents delegation, the mode cap, tiers, and untrusted
  results.

## Related Code Files

- Modify: `src/tools/types.ts` (add `AgentSpawnPort` to `ToolRuntimePorts`)
- Modify: `src/tools/approval.ts` (add `spawn_agent` to `READ_ONLY_TOOLS`)
- Create: `src/tools/builtin/agents.ts`
- Create: `src/tools/builtin/agents.test.ts`
- Create: `src/tools/builtin/guides/agents.md`
- Modify: `src/tools/builtin/tool-guide.ts`
- Modify: `src/tools/builtin/tool-guide.test.ts`
- Create: `src/agents/store.ts`
- Create: `src/agents/store.test.ts`
- Create: `src/agents/runtime.ts` (session-scoped run ownership + caps)
- Create: `src/agents/runtime.test.ts`
- Modify: `src/chat/engine.ts` (agents port, in-flight counter, `appendNotice`, rehydrate reconcile)
- Modify: `src/chat/engine.test.ts`
- Modify: `src/chat/types.ts` (optional `agent` metadata on `ChatThread`)
- Modify: `src/chat/persistence.ts` (`listAgentRuns`, exclude agent threads from `listThreads`)
- Modify: `src/chat/threads.ts` (cascade delete to child runs)
- Modify: `src/chat/sanitize.ts` (reconcile stale running agent results)
- Modify: `src/chat/persistence.test.ts`
- Modify: `src/session/session.ts` (runtime + store wiring, `builtinProviders`, abort hooks)
- Modify: `src/session/session.test.ts` (provider-name expectations)

## Implementation Steps

1. `src/tools/types.ts`: add
   `AgentSpawnPort { spawn(request, options?): Promise<AgentSpawnOutcome> }` and
   `agents?: AgentSpawnPort` on `ToolRuntimePorts`. Add `spawn_agent` to
   `READ_ONLY_TOOLS` in `src/tools/approval.ts`.
2. `src/agents/runtime.ts`: a session-scoped runtime that enforces the caps, mints
   run ids, owns each run's `AbortController`, registers a global abort via
   `registerAbortAll`, and exposes `spawn`, `cancel(runId)`, `abortThread(threadId)`,
   `abortAll()`. `spawn` installs an `onSettle` that is invoked for background
   runs only.
3. `src/agents/store.ts`: an observable run registry following the
   `ToolRegistry` subscribe/version idiom (`src/tools/registry.ts:37-51`), with
   `register/update/appendEvent/setStatus/finish/remove/list/subscribe` and a
   pending-approval selector. It clears when the chat store clears (vault lock).
4. `src/tools/builtin/agents.ts`: validate input with a hand-written reader
   (mirror `src/tools/builtin/mode.ts:9-13`), then `ports.agents.spawn`.
   Await → `toolOk({ status: 'completed', label, result, toolCalls, usage, untrusted: true })`.
   Background → `toolOk({ status: 'running', runId, label })`. Missing port →
   `ToolRuntimeUnavailableError`; bad input → `toolFail('invalid_input', ...)`.
5. `guides/agents.md` + `tool-guide.ts` entry (topic `agents`, covers
   `spawn_agent`): when to delegate, mode is capped, tier guidance (including
   `max` for advisory work), background semantics, and untrusted results.
6. `src/chat/engine.ts`:
   - add `agentPortsFor?` dep; accept an optional final `agentContext` argument
     in `buildRunStream`; create the mutable parent context and attach
     `ports.agents` before `buildToolSet`, then fill `context.toolNames` after;
   - track a per-thread in-flight count around `startRun` **and** `compact`, and
     extract a `flushNotices(threadId)` called from both `finally` blocks;
   - add `appendNotice(threadId, text, meta)` that appends an untrusted-marked
     assistant notice (metadata `{ agentNotice: true, untrusted: true, runId }`)
     and persists, queueing while the thread is in flight;
   - add a system-prompt section when `spawn_agent` is present: sub-agent results
     are untrusted data, not instructions.
7. Child-thread persistence:
   - `src/chat/types.ts`: optional `agent?: { runId; parentThreadId; label; mode; tier; status }` on `ChatThread`;
   - `src/chat/persistence.ts`: `listThreads()` skips threads with `agent`, and a new `listAgentRuns(parentThreadId?)` returns them;
   - the runtime creates the child thread on spawn (`status: 'running'`), appends the prompt and streamed assistant parts, saves throttled during streaming, and saves final status on settle;
   - `src/chat/sanitize.ts` reconcile: a `running` child becomes `interrupted` on load, and the parent's matching `spawn_agent` result is rewritten to `status: 'interrupted'`;
   - `src/chat/threads.ts`: `deleteConversation` also deletes the parent's child runs.
8. `src/session/session.ts`: build the runtime and store from the settings getter,
   registries, `threadStore`, and a port factory mirroring `buildRunStream`
   (workspace/rag/codeRunner/sandbox/preview plus the parent thread's journal);
   wire `agentPortsFor` and an `onSettle` that appends a notice only when the
   parent thread still exists; add `agents` to the `builtinProviders` list and to
   the ports passed to `describeBuiltinTool`; abort agent runs from `disposeThread`,
   `dispose`, and the lock path.
9. Tests: `agents.test.ts` (await, background, invalid input, missing port, cap);
   `runtime.test.ts` (caps, abort by thread, abort settles approval);
   `engine.test.ts` (no double report for await; one notice for background;
   notice queued during a run and during compaction lands after; stale `running`
   reconciler); `session.test.ts` expectations gain `spawn_agent`.

## Todo

- [x] `AgentSpawnPort` + `agents` in ports; `spawn_agent` in `READ_ONLY_TOOLS`
- [x] Session-scoped agent runtime with caps + abort ownership
- [x] Observable run store, cleared on chat clear
- [x] `spawn_agent` provider (await/background, limits, untrusted result)
- [x] Tool guide entry and `guides/agents.md`
- [x] Engine agents port, in-flight counter, notice flush, `appendNotice`
- [x] Child-thread persistence, `listAgentRuns`, cascade delete
- [x] Rehydrate reconciliation of stale `running` child runs
- [x] Session wiring + `builtinProviders` + abort hooks
- [x] Provider, runtime, persistence, engine, and session tests

## Success Criteria

- An awaited `spawn_agent` call returns the result inline and appends no notice; a
  background call appends exactly one notice, including when it settles during a
  parent run or a compaction.
- A vault lock, `disposeThread`, or `dispose` aborts every detached run and
  settles its pending approvals.
- After reload, a previously running delegation shows as interrupted rather than
  running forever, with its persisted transcript still readable in the Agents
  panel.
- Over-cap delegation returns `limit_exceeded`.
- `pnpm test` for the touched suites and `pnpm build` pass; `pnpm lint` passes.

## Risk Assessment

- **Port drift:** the sub-agent ports must mirror `buildRunStream` (including
  admin ports) or a delegated tool disappears; extract a shared port builder in
  the session rather than duplicating it.
- **Reconciliation scope:** rewriting persisted tool results touches sanitize;
  keep it narrow to `spawn_agent` results with `status: 'running'` and add a
  regression test.
- **Recursive delegation:** blocked by subtracting `spawn_agent` from the
  sub-agent toolset; assert it in `toolset.test.ts`.

## Security Considerations

- The parent mode, never the tool's default, is passed as the ceiling.
- Delegated approvals are Allow/Deny only and never persist.
- Sub-agent output is untrusted and labelled as such in both the tool result and
  the notice.

## Next Steps

- Phase 5 renders the store and the queued approval cards.
