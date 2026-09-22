# Red-team failure review — Sub-agent delegation

Lens: failure-mode analyst. Verdict: the plan is not production-safe as written.
Its UI/UX scope is coherent, but the lifecycle of detached work is unowned:
nothing in the plan aborts, settles, reconciles, or attributes a sub-agent once
the parent turn stops being the thing on screen.

Verified against `src/chat/engine.ts`, `src/chat/store.ts`, `src/vault/store.ts`,
`src/session/session.ts`, `src/workspace/journal.ts`,
`src/workspace/journal-store.ts`, `src/chat/persistence.ts`,
`src/chat/sanitize.ts`, `src/chat/threads.ts`, `src/ui/panels/conversations.tsx`,
and the `ai@7.0.105` `ToolExecutionOptions` surface.

---

## 1. No teardown owns detached agent runs — they outlive lock, delete, and dispose

**Severity: Critical**

Evidence:
- `src/chat/engine.ts:466-468` — the global-abort callback aborts only the
  per-thread controllers in `this.controllers`.
- `src/chat/store.ts:169-174` — a vault lock calls `abortAll()` then
  `useChatStore.getState().clear()`, wiping chat state.
- `src/session/session.ts:320-336` — `dispose()` disposes engines, flushes and
  clears the journal; it has no agent-runtime teardown.
- `src/ui/panels/conversations.tsx:130-139` — deleting a conversation calls
  `session.disposeThread(id)` only.
- `plans/.../phase-04-spawn-agent-tool.md:135` — "background runs are abortable
  and must register with the global abort so a vault lock stops them" is stated
  as a requirement, but no implementation step (phase-04 steps 1-8) does it.

Why it breaks: a background run's `AbortController` is not the parent thread's
controller, so `abortAll()` cannot reach it. On lock, the chat state is cleared
under a still-streaming nested run (real provider cost and egress after the vault
claims to be locked). On conversation delete, the run keeps invoking workspace
tools. Its settle callback then calls `engineFor(parentThreadId).appendNotice(...)`
(phase-04:90-94); `engineFor` recreates a just-disposed engine
(`src/session/session.ts:304-311`), and the parent journal slot that
`deleteConversation` removed (`src/chat/threads.ts:94-100`) is silently recreated
by `forThread` (`src/workspace/journal-store.ts:129-138`), orphaning the journal.

Suggested plan fix: make the agent runtime own per-run controllers and expose
`abortThread(threadId)` / `abortAll()`; register `abortAll` through
`registerAbortAll`; call it from `session.dispose`, `session.disposeThread`, the
vault-lock subscription, and the settle callback must drop notices whose parent
thread is absent.

---

## 2. Pending-approval promises have no lifecycle owner — unsettleable, leaked run

**Severity: Critical**

Evidence:
- `phase-03-agent-runtime-core.md:84-87` — `createApprovalQueue({ persist })`'s
  `request` returns a promise resolved only by `resolve(id, answer)`.
- `phase-03-agent-runtime-core.md:136` — the deadlock is admitted only in Risk
  Assessment ("the queue must also be resolvable by cancellation"); it is not a
  Requirement and not an implementation step.
- `src/chat/engine.ts:644-649` — `cancel(threadId)` aborts only the thread's
  controller and returns immediately if none exists.
- `src/chat/engine.ts:471-476` — `dispose()` clears `controllers`/`runs` without
  settling anything the agent layer holds.
- `src/vault/store.ts:309-320` — after lock, `update()` rejects with
  `VaultLockedError`.

Why it breaks: a sub-agent paused on `user-approval` awaits a promise whose only
resolver is the panel. Abort, cancel, lock, and thread-delete never call
`resolve`. If the run promise never settles, the store entry stays `running`
forever, the Agents-panel cancel button cannot clear it, and the tool `execute`
promise inside the nested `streamText` leaks for the life of the tab. For the
await path this is worse than a leak: `cancel(threadId)` returns immediately once
the parent turn has settled, so there is no handle at all to the paused child.

Suggested plan fix: `createApprovalQueue({ persist, signal })`; on `signal` abort
(and on lock/delete) reject/resolve pending entries with `false`. Require
`AgentSpawnPort.spawn` to always receive a per-run controller owned by the agent
store and registered with the global abort; add explicit contract tests
"abort settles every pending approval" to phase-03.

---

## 3. Notice flush lives only in `startRun`'s `finally`; compaction holds the same controller

**Severity: High**

Evidence:
- `phase-04-spawn-agent-tool.md:31-33, 89` — queue a notice when a run is in
  flight; flush on settle in `startRun`'s `finally`.
- `src/chat/engine.ts:623-624` — a manual `compact()` registers a controller for
  the thread.
- `src/chat/engine.ts:637-641` — `compact()`'s `finally` releases it but never
  flushes notices.
- `src/chat/engine.ts:610-618` — `compact()` is a public, user-triggered path.
- `src/chat/engine.ts:739-757` — `autoCompact` runs inside a run, so it is
  covered; the manual path is not.

Why it breaks: the plan keys "in flight" off the per-thread controller. A manual
compaction also sets that controller. If a background agent settles during a
manual compaction, `appendNotice` queues the notice, no `startRun` follows, and
the notice is stranded until the user happens to send another turn — or forever
if they reload. This is notice loss the phase-04 acceptance test ("none is lost
if the parent was streaming") will not catch, because it never exercises
compaction.

Suggested plan fix: key the queue off the run lifecycle, not off `controllers`
(e.g. an explicit `inFlight` flag set in `startRun`), or flush the queue in every
`finally` that releases a thread controller, including `compact`. Add a
"notice during manual compaction is delivered when compaction ends" test.

---

## 4. In-memory runs plus a persisted `status: 'running'` tool result = permanent phantom

**Severity: High**

Evidence:
- `phase-04-spawn-agent-tool.md:72` — the run registry is an in-memory observable
  store.
- `phase-04-spawn-agent-tool.md:80` — the background tool result is
  `{ status: 'running', runId }`.
- `src/chat/engine.ts:938-940` — the assistant message carrying that result is
  persisted.
- `src/chat/sanitize.ts:91-104` — `rehydrateThread` expires only *non-terminal*
  tool parts; `output-available {status:'running'}` is terminal and survives.
- `src/chat/persistence.ts:98-105` — the thread round-trips unchanged.

Why it breaks: after reload the registry is empty, so the runId resolves to
nothing. The parent conversation still advertises a running delegated task, the
Agents panel is empty, no notice will ever arrive, and there is no button to
clear it. If the run was paused on an approval, the card is gone and the promise
is dead — a dead UI state with no recovery except deleting the conversation.

Suggested plan fix: add a rehydrate-time reconciliation that rewrites persisted
`agentNotice`/`status:'running'` results to an explicit interrupted/failed shape
(reuse the `INTERRUPTED_ERROR` convention in `sanitizePart`), and clear/deny the
store's pending approvals whenever chat state is cleared.

---

## 5. Cost caps are per-run; scope is unspecified and the parent loop is unbounded

**Severity: Medium**

Evidence:
- `phase-03-agent-runtime-core.md:100` — `MAX_AGENT_STEPS` /
  `MAX_AGENT_OUTPUT_CHARS` bound one nested run.
- `phase-04-spawn-agent-tool.md:46, 116` — "concurrency is capped" /
  "limit_exceeded", with no scope (global vs per thread vs per turn).
- `src/chat/engine.ts:400-417` — the parent is `stopWhen: () => false`.

Why it breaks: a single parent turn can await an unbounded number of sub-agents
because the parent never stops on step count, and only the awaited count is
bounded by "whatever the cap is". If the cap is per-thread, N open conversations
multiply it. Nothing bounds total spend within a turn across spawns.

Suggested plan fix: state the scope explicitly (e.g. global max concurrent runs +
per-turn max spawns), count awaited runs against the same cap as background runs,
and add a per-turn spawn budget that persists across the parent's tool steps.

---

## 6. Sub-agent writes share the parent journal with no provenance; delete races a live writer

**Severity: Medium**

Evidence:
- `phase-04-spawn-agent-tool.md:29-30, 92-94` — the runner receives the parent
  thread's journal so checkpoint/restore reverses sub-agent writes.
- `src/workspace/journal.ts:196-211` — restore resolution is purely `seq`-based
  (`lastBeforeMarker` / `earliestAfterMarker`).
- `src/workspace/journal.ts:255-287` — `planRestore` reconstructs from that seq
  ordering.
- `src/chat/threads.ts:94-100` + `src/workspace/journal-store.ts:152-160` —
  delete drops the slot; `forThread` (`:129-138`) recreates it on the next write.
- `phase-04-spawn-agent-tool.md:135` — background runs are meant to be abortable.

Why it breaks: concurrent detached agents and the parent run interleave into one
`seq` space with no agent id. A checkpoint taken before a background agent's
writes makes `restore` revert files the user never saw written in that turn, and
history/undo cannot attribute or reverse one agent's work. Deleting the
conversation removes the journal slot while a detached writer is mid-flight; the
next `record` silently re-creates an orphan journal, losing the original entries
from persistence (the same teardown gap as finding 1).

Suggested plan fix: add an `agentId`/`runId` field to `JournalEntry` and either
scope each sub-agent's writes to a child checkpoint the parent commits on settle,
or guarantee writers are aborted and drained before `journalStore.remove` on
delete.

---

Status: DONE_WITH_CONCERNS
Summary: Six lifecycle defects found; the plan's teardown/abort/reconciliation story for detached sub-agent runs is the blocking theme — nothing owns background-run abort, approval settlement, or reload reconciliation.
Concerns/Blockers: Findings 1-2 must be resolved at the requirements/implementation-step level (not only in Risk Assessment) before phase 3/4 are coded; findings 3-4 need explicit tests for compaction and reload, which the current acceptance criteria do not cover.
