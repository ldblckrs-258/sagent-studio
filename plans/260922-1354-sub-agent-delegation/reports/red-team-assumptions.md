# Red-team assumptions review — Sub-agent delegation

Lens: hostile assumption destroyer. Question asked of every load-bearing claim:
*is this actually true against the code and the installed `ai@7` types, or was it
assumed?* Findings ordered by severity, each anchored to a `path:line`. Cap: 6.

Plan under review: `plans/260922-1354-sub-agent-delegation/` (plan.md + phase-01..06).
Codebase: `sagent-studio` @ `main` (`ai@7.0.105`).

---

## Assumption verdicts (the 8 under attack)

| # | Assumption | Verdict |
|---|-----------|---------|
| 1 | `streamText` `stopWhen: stepCountIs(n)`, bounded loop, collect `text`/`steps`/`usage` | **PASS.** `stepCountIs` is exported (alias of `isStepCount`), `StopCondition` accepts it (`node_modules/ai/dist/index.d.ts:3510`, export list L10025). |
| 2 | A `buildToolSet` tool can be re-wrapped by spreading + replacing `execute` | **PASS mechanically.** `tool()` returns a plain, non-frozen object with an enumerable own `execute`; `{...t, execute}` preserves it (verified at runtime against `ai@7.0.105`). The plan's *use* of it is still challenged — see F1/F6. |
| 3 | `modeCeiling`/`isWithinCeiling` correctly classifies user tools and can filter an agent toolset | **PARTIAL.** The classification works, but availability is not the ceiling — see F1. |
| 4 | `skillRegistry.toolNamesFor` + `resolve` can narrow a sub-agent toolset | **FAIL.** `resolve` only returns *enabled* skills and `undefined` means "all tools" — see F3. |
| 5 | `buildRunStream` can attach a per-run `agents` port with parent context | **FAIL.** No `threadId`; port cannot be assembled as specified — see F1/F2. |
| 6 | `appendNotice` mid-stream can be queued and flushed safely | **UNPROVEN / risky.** Clobbering persist + unspecified flush point + disposal — see F4/F6. |
| 7 | Vault migration carries `subModel`→`modelTiers.cheap` + `lastModel` without breakage | **MOSTLY PASS.** No code-level break found; only caller-list/`SKILL`-style coverage is at risk (phase-01 lists all call sites: `session.ts`, `title.ts`, `ProvidersPanel.tsx`). |
| 8 | `MockLanguageModelV4` is sufficient to test nested agent runs | **FAIL.** Harness factory ignores provider/model and the mock sequences by call index — see F5. |

---

## Finding 1 — CRITICAL: `spawn_agent` can never become available under the plan's stated wiring

**Severity:** Critical (the feature does not function; the whole plan gates on it)

**Evidence**
- `buildRunStream` builds `ports` (`src/chat/engine.ts:332-349`), then computes the
  pool (`src/chat/engine.ts:350`) and only then builds the toolset
  (`src/chat/engine.ts:369`).
- Availability is decided by `availableNames`, which includes a name **only** when
  `provider.isAvailable(ports)` is true: `src/tools/registry.ts:129-138`;
  `buildToolSet` then intersects with that pool at `src/tools/registry.ts:140-157`.
- Mode membership is irrelevant to availability: `READ_ONLY_TOOLS`
  (`src/tools/approval.ts:31-48`, which phase-04 step 2 edits) feeds
  `modeCeiling`/`resolveApprovalStatus` (`src/tools/approval.ts:136-170`), never
  `availableNames`.
- Phase-04 step 6 requires the port to carry `toolNames = Object.keys(toolSet)`
  (`plans/.../phase-04-spawn-agent-tool.md:86`), but that value exists only *after*
  `buildToolSet`, i.e. *after* `availableNames` already decided spawn_agent's fate.

**Why it breaks**
Circular dependency. If the agent provider's `isAvailable` checks `ports.agents`,
the port is `undefined` at `engine.ts:350`, so `spawn_agent` is absent from the pool
and is never offered to the model regardless of `READ_ONLY_TOOLS`. If it returns
`true` unconditionally, the parent context still cannot be populated, because the
`toolNames` the port must carry are produced by the very call that builds the port.
The `create` closure at `src/tools/registry.ts:150/154` does capture `ports` by
reference, so a *later* mutation is visible — but the plan's stated step order
(attach after the toolset) cannot satisfy either the availability check or the
context.

**Concrete plan fix**
- Register the agent provider with `isAvailable: () => true` (or gate on the
  session-level `agentPortsFor` dep, not on `ports.agents`), and attach a
  **lazily-resolving** port *before* `engine.ts:350`: pass `mode`/`config` directly
  and `getToolNames: () => Object.keys(toolSet)` (or pass the already-computed
  `requestedTools`) so the port does not need the toolset object to pre-exist.
- Add the provider to the hardcoded list in `session.ts:365-379`
  (`builtinProviders`) or it will not appear in the Tools UI either.

---

## Finding 2 — HIGH: `buildRunStream` has no `threadId`, so the parent context cannot be assembled

**Severity:** High (blocks phase 4; forces a signature change the plan omits)

**Evidence**
- Signature: `src/chat/engine.ts:316-326` — `deps, config, messages, signal,
  generateMessageId, mode, modePort, planPort, journal`. No thread id.
- Callers: `src/chat/engine.ts:873` (inside `executeRun`, which *does* have
  `thread.id` at `:870`) and `src/chat/transport.ts:14` (passes only 5 args, typed
  against `ChatTransportDeps` at `:6-8`).
- Phase-04 step 6 demands `ports.agents` built with
  `{ threadId, mode, config, toolNames, skills }`
  (`plans/.../phase-04-spawn-agent-tool.md:86`).

**Why it breaks**
`threadId` is not in scope where the port must be created. The plan's Related Code
Files (`phase-04:60-62`) list only `engine.ts` and `session.ts` — not
`transport.ts` — so adding a positional `threadId` argument silently breaks the
transport call site (`src/chat/transport.ts:14`) and `transport.test.ts`. `config`
and `mode` are in scope; `threadId` is not.

**Concrete plan fix**
Carry the context through the dep factory instead of a positional arg: change the
planned dep to `agentPortsFor?(threadId, config, mode, names)` and invoke it from
`executeRun` (`engine.ts:868-883`) where `thread.id` exists, or pass `threadId` in
an options object while defaulting `transport.ts:14` to the existing 5-arg form.

---

## Finding 3 — HIGH: skill narrowing cannot activate requested skills; `undefined` silently widens the toolset

**Severity:** High (security-adjacent: request implies narrowing, implementation widens)

**Evidence**
- `SkillRegistry.resolve` returns **only enabled** skills:
  `src/skills/registry.ts:118-138` (`if (!this.enabled.has(key)) continue`).
- `toolNamesFor` returns `undefined` when nothing resolves:
  `src/skills/registry.ts:147-161`.
- `buildRunStream` interprets `undefined` as "all tools" (the union is only applied
  when `narrowed !== undefined`): `src/chat/engine.ts:351-368`.
- `skillKey` is `` `${source}:${id}` `` (`src/skills/schema.ts:27-29`), so
  "preferring the vault source" (phase-03 step 5, `phase-03:90-91`) has no
  expression in `resolve`, which keys strictly by source.

**Why it breaks**
`spawn_agent({ skills: ['x'] })` where `x` is disabled, unknown, or workspace-only:
`resolve` yields zero skills → `toolNamesFor` yields `undefined` → mirroring
`buildRunStream` hands the sub-agent the **full parent pool** instead of the
narrowed set, exactly opposite the request. A misspelled skill is therefore
indistinguishable from "no narrowing", and a workspace-only id can never be turned
into the "preferred vault" ref because both refs have distinct keys.

**Concrete plan fix**
In `resolveAgentToolNames`, resolve each requested id explicitly against both
`{id, source:'vault'}` and `{id, source:'workspace'}` (via `get`/`resolve`), prefer
vault, and treat "requested skills that resolve to nothing" as an explicit
`tool_not_found`/`invalid_input` tool result rather than falling back to the full
pool. Only fall back to "all tools" when no skills were requested at all.

---

## Finding 4 — HIGH: await agents are double-reported (inline result + settle notice)

**Severity:** High (duplicate transcript messages; false accounting)

**Evidence**
- Awaited path returns the result inline:
  `plans/.../phase-04-spawn-agent-tool.md:43` ("Await returns the agent result
  inline").
- The runtime's `onSettle` unconditionally calls
  `engineFor(parentThreadId).appendNotice(...)`:
  `plans/.../phase-04-spawn-agent-tool.md:93-94`.
- The success criterion only distinguishes the background case:
  `plans/.../phase-04-spawn-agent-tool.md:114-115` ("When a background run settles,
  exactly one notice message appears").

**Why it breaks**
Nothing in the plan gates `onSettle` on `background`. For `background:false`, the
sub-agent's text already arrives as the `spawn_agent` tool result; the same settle
then appends a second assistant notice to the parent thread. The parent thread now
contains the same delegation result twice, and the "exactly one notice" assertion
holds only if the await case happens to be tested separately.

**Concrete plan fix**
Gate `onSettle` on the run's `background` flag (or only append a notice when the
tool result was not delivered inline). State it as a phase-04 requirement and assert
it in `agents.test.ts`.

---

## Finding 5 — MEDIUM: the harness mock cannot target a "sub-model stream"; two loops share one call-indexed array

**Severity:** Medium (phase-06 e2e is likely to test the wrong thing or flake)

**Evidence**
- Phase-03 step 5 falls back to "the parent's `modelFactory(settings,
  config.providerId, config.modelId)`" (`plans/.../phase-03-agent-runtime-core.md:94-95`).
- The harness factory ignores its arguments and returns the parent model:
  `src/chat/harness-e2e.test.ts:156` (`modelFactory: () => model as unknown as
  LanguageModel`), and `defaultSettings()` has no tier block
  (`src/vault/settings.ts:151-179`).
- `MockLanguageModelV4` picks its response by call index:
  `node_modules/ai/dist/test/index.js:168-176`
  (`doStream[this.doStreamCalls.length - 1]`), over a single fixed chunk array
  (`src/chat/harness-e2e.test.ts:131-147`).

**Why it breaks**
With `defaultSettings()` no tier resolves, so the nested run falls back to the same
factory that returns the parent model. Parent step 1, the nested run, and the parent
continuation then become positions in one shared `doStream` array consumed via one
shared `doStreamCalls` counter. Any extra SDK call (retry, repair, an extra step)
shifts every index, so the "sub-model stream" is not actually targeted — the test
either asserts the wrong stream or throws when the array is exhausted. Phase-06's
premise ("a parent stream ... a sub-model stream ...",
`plans/.../phase-06-docs-and-e2e.md:54-57`) assumes the two are separable.

**Concrete plan fix**
In the phase-06 e2e, configure `modelTiers` for the tier under test (or use a
`modelFactory` that branches on `providerId`/`modelId`) and give each model a
`doStream` **function** keyed on the requested tools rather than relying on array
order.

---

## Finding 6 — MEDIUM: notice-flush point is unspecified; the run's own persist clobbers it, and a late settle can resurrect a disposed engine

**Severity:** Medium (lost notices / post-lock writes)

**Evidence**
- `executeRun` writes `[...siblings, finished]`, where
  `siblings = baseMessages.filter((m) => m.id !== assistantId)` was captured at run
  start (`src/chat/engine.ts:893`) and written at `src/chat/engine.ts:939`. Any
  message appended to the store during the run that is not part of `latest` is
  dropped by that write.
- `startRun`'s `finally` deletes the per-thread controller at `engine.ts:825`
  **before** `endRun` at `:827`.
- `engineFor` recreates an engine lazily (`src/session/session.ts:302-311`) and
  `dispose()` only aborts that engine's own controllers
  (`src/chat/engine.ts:471-476`).

**Why it breaks**
Phase-04 step 6 asserts a notice "is queued and flushed when the run settles"
(`plans/.../phase-04-spawn-agent-tool.md:88-89`) but never names the flush point.
Flush anywhere before `engine.ts:939` and the notice is clobbered by the run's own
persist. Separately, a background agent that settles after `dispose()` (vault lock)
calls `onSettle` → `engineFor` → a freshly recreated engine writes into a cleared
store / locked vault.

**Concrete plan fix**
Flush the per-thread notice queue in the `run` promise's `finally` for **every**
outcome (success, abort, failure) and only after `executeRun` has persisted. Have
`onSettle` verify the session still owns the thread (and drop the notice) instead of
recreating an engine through `engineFor`.

---

Status: DONE_WITH_CONCERNS
Summary: Two load-bearing assumptions are false as written — `spawn_agent` cannot be made available under the plan's port/toolset ordering (F1), and requested-skill narrowing silently widens the sub-agent toolset (F3) — with `buildRunStream`'s missing `threadId` (F2), await-agent double reporting (F4), and a mock that cannot target a sub-model stream (F5) close behind.
Concerns/Blockers: Findings 1–2 are prerequisites for phase 4 compiling and functioning at all; F3 is a security-adjacent narrowing bug. Assumption 2's mechanism (spread + replace `execute`) is verified valid, but its *use* as a second approval gate is challenged by the scope report and remains an unproven second source of truth for consent.
