# Red-team scope & complexity review — Sub-agent delegation

Lens: hostile scope/complexity critic. Question asked of every section: where is
this over-built, under-specified, or not deliverable? Findings ordered by
severity, every one anchored to a `path:line`. Cap: 6.

Plan under review: `plans/260922-1354-sub-agent-delegation/` (plan.md + phase-01..06).
Codebase: `sagent-studio` @ `main`.

---

## Finding 1 — HIGH: Approval-by-execute-wrapping is redundant; `toolApproval` already takes an async per-call decision function

**Severity:** High (over-build; ~1 of 6 phases' risk surface added for nothing)

**Evidence**
- Plan's core justification: "A nested run cannot reuse that (it has no persisted
  message to resume), so sub-agent approval is enforced by wrapping each gated
  tool's `execute`" — `plans/260922-1354-sub-agent-delegation/phase-03-agent-runtime-core.md:24-28`,
  re-stated as a requirement at `phase-03:53-54` and step 5 at `phase-03:91-93`.
- The SDK the plan already builds on accepts a **generic async** approval
  function and awaits it before executing the tool:
  `node_modules/ai/dist/index.js:4665-4674` (`await toolApproval({...})`), typed at
  `node_modules/ai/dist/index.d.ts:3069-3091` with a `MaybePromiseLike` return at
  `:3060-3063`; per-tool async functions are also supported at
  `node_modules/ai/dist/index.d.ts:3111-3112`.
- The existing map builder confirms the surface is already the app's gate:
  `src/chat/approval.ts:11-21` (`createToolApproval`) is passed straight to
  `streamText` at `src/chat/engine.ts:385`, `:405`.

**Why it is over-build**
The plan is right that the *persisted-message resume* path
(`respondToApproval`, `src/chat/engine.ts:553-608`) is not reusable. It then
concludes the *decision* path is not reusable either — that does not follow. A
`toolApproval` function can `await` the agent approval queue and return
`'approved'` or `'denied'`; the SDK never emits an `approval-requested` part for
an already-decided call, so no resume and no persisted message are needed. The
plan therefore adds a second approval model (per-tool `execute` rewriting in
`src/agents/runner.ts`) alongside the one the codebase already uses, doubling the
place a consent decision can diverge.

**Concrete plan fix**
- `phase-03` step 5: build `toolApproval` from `resolveApprovalStatus`
  (`src/tools/approval.ts:155-169`) with the gated tool's entry as an `async`
  function that awaits `AgentApprovalQueue.request(...)` and maps
  `allow→'approved'`, `deny→'denied'`. Pass it to `streamText` exactly as
  `buildRunStream` does (`src/chat/engine.ts:400-417`).
- Delete the "wrap each gated tool's `execute`" mechanism. Keep the queue (it is
  the UI bridge), drop the execute-rewriting layer.
- Add one `runner.test.ts` case proving a `user-approval` tool blocks until
  `resolve(id, 'allow')` and then runs.

---

## Finding 2 — HIGH: `resolveAgentToolNames` re-implements `buildRunStream`'s narrowing/union, and the two are already diverging on a security boundary

**Severity:** High (duplicate authority over the mode ceiling)

**Evidence**
- Parent resolver lives in `src/chat/engine.ts:350-369`: pool →
  `skillRegistry.toolNamesFor` → union `SKILL_INDEX_TOOLS`/`GUIDE_TOOLS`.
- Plan asks the sub-agent to reproduce it: "Skill narrowing must mirror
  `buildRunStream`" (`phase-03:31-32`) and step 3 orders ceiling filter →
  subtract blocked/excluded → **then** union skill tools (`phase-03:78-83`).
- That ordering is not cosmetic: `change_mode` and `update_plan` sit in
  `READ_ONLY_TOOLS` (`src/tools/approval.ts:31-48`), so they survive the ceiling
  filter in every mode, and the skill re-union can re-introduce them after the
  block subtraction. The sibling security report already records this as its
  CRITICAL finding (`reports/red-team-security.md:15-33`).

**Why it is over-build / not deliverable as written**
"Mirror `buildRunStream`" is an instruction to copy five non-trivial steps into a
new module with no test that the two stay equal. The drift already happened on
paper before a line was written. Two resolvers means the mode clamp can be
correct in one and wrong in the other indefinitely.

**Concrete plan fix**
- Extract one pure helper (e.g. `resolveRunTools({ config, mode, pool, skillRefs, exclude })`)
  next to `src/chat/engine.ts:350-369`, and call it from both `buildRunStream`
  and `runAgent`. This is the same move `phase-04:126` already mandates for the
  *ports* ("extract a shared port builder ... rather than duplicating it") —
  apply it to the toolset too.
- Make the denial projection final: filter by `isWithinCeiling`
  (`src/tools/approval.ts:141-146`) and subtract `BLOCKED_AGENT_TOOLS` **after**
  the skill union, as the security report proposes.

---

## Finding 3 — HIGH: Phase 4's file list omits the test that asserts the exact tool pool, and never specifies `isAvailable`

**Severity:** High (unverifiable acceptance criteria; phase 6 gate will fail)

**Evidence**
- `src/session/session.test.ts:89-95`, `:99-105`, `:117-125` assert **exact
  equality** on `availableNames({})` (e.g. `['change_mode','read_tool_guide',
  'reset_sandbox','run_js','run_python']`).
- `ToolProvider.isAvailable` decides that list (`src/tools/registry.ts:129-138`);
  the mode tool proves the trivial pattern `isAvailable: () => true`
  (`src/tools/builtin/mode.ts:23`).
- `phase-04:49-63` lists the files to touch: `session/session.ts` is there,
  `session/session.test.ts` is not. Step 4 only says "Missing port →
  `ToolRuntimeUnavailableError`" (`phase-04:81`) — it never states the
  provider's `isAvailable`.
- `session.builtinProviders()` iterates a **hardcoded** provider list at
  `src/session/session.ts:365-379`; a new provider not appended there never
  appears in the Tools panel (`src/ui/panels/tools.tsx:330`) or the Approvals
  policy list (`src/ui/panels/approvals.tsx:23`).

**Why it breaks**
If `isAvailable` is `() => true`, three exact-array assertions in a file the plan
does not list go red, and phase 6's "`pnpm test` passes" is unsatisfiable without
an unplanned edit. If instead it is `(ports) => ports.agents !== undefined`, the
existing tests pass but `spawn_agent` is silently absent from the Tools and
Approvals panels because `builtinProviders` never gets the port — a shipped
behavior the plan claims to expose. Either branch is currently unpinned.

**Concrete plan fix**
- Pick and write down `isAvailable: (ports) => ports.agents !== undefined`, then
  add `src/session/session.test.ts` to `phase-04`'s file list with the expected
  new `availableNames({})` value (spawn_agent absent without the port, present
  with it), plus an assertion that `builtinProviders()` lists `spawn_agent`.
- Add `agentProvider` to the `builtinProviders` list at `src/session/session.ts:365-379`
  and say so in step 7.

---

## Finding 4 — MEDIUM: Four tiers is three tiers of unreachable config

**Severity:** Medium (unused scope; misleading UI)

**Evidence**
- `tierForMode(mode)` maps only three modes: `read_only→cheap`,
  `editing→medium`, `god→high` (`phase-01:41`). `max` has **no** producer
  anywhere in the plan.
- The only defaulted consumer is `spawn_agent`, whose `mode` defaults to
  `read_only` (`phase-04:41`), so the default delegation path resolves to
  `cheap` — the same tier the old `subModel` becomes.
- The only way `medium`/`high`/`max` are ever used is a model explicitly passing
  `tier` (`phase-04:39-41`), and nothing in phases 1/3/4 tests that a non-cheap
  tier resolves to a non-null model.
- The shipped consumers of tiers are `cheap` only: `titleModel`
  (`src/chat/title.ts:146-158`) and `rewriteModel`
  (`src/session/session.ts:243`), both `phase-01:76-77`.

**Why it is a real gap, not acceptable**
The plan ships a Provider UI with four selectors (`phase-01:78-80`) and a
migration narrative about four tiers, but for a user who never uses explicit
`tier`, `medium`/`high`/`max` are write-only settings. Worse, the default
delegated task — the headline feature — runs on `cheap`, so a user who sets only
`medium` gets no effect from the setting they configured.

**Concrete plan fix** (targeted, not a rewrite)
- Either cut to two tiers (`cheap` for auxiliary work, `delegate` for
  `spawn_agent`, explicitly defaulted) and drop `MODEL_TIERS` to two; or
- Keep four, but (a) delete `tierForMode`'s `max` blind spot by documenting it as
  explicit-only, (b) make `spawn_agent`'s default tier a defined
  `DEFAULT_DELEGATION_TIER` rather than mode-derived, and (c) add a
  `model-tier.test.ts` case per tier asserting `createTierModel` resolves each
  one. Any tier with no producer and no test should not ship.

---

## Finding 5 — MEDIUM: `agents/store.ts` + `useAgentStore` rebuilds the registry-observer idiom already in the repo, and the `persist` callback forks the policy writer

**Severity:** Medium (duplicate abstractions)

**Evidence**
- The plan's store surface is `register/update/appendEvent/setStatus/finish/
  remove/list/subscribe` plus `pendingApprovalCount` (`phase-04:72-75`), and
  phase 5 re-invents the subscription hook: "Add a `useAgentStore` subscription
  hook (or a `useSyncExternalStore` selector)" (`phase-05:56-57`).
- That exact contract already exists as `ToolRegistry`
  (`src/tools/registry.ts:30-51`: `subscribe`, `getVersion`, private `notify`)
  with the ready-made consumer hook `useRegistryVersion`
  (`src/ui/use-registry-version.ts:13-19`), which `ComposerControls` already uses
  (`src/ui/composer-controls.tsx:514`).
- `allow-always` persistence is delegated to "a caller-provided callback"
  (`phase-03:51-52`, `phase-03:86-87`) with no named owner; the repo already owns
  that write: `PipelineDeps.persistApproval` (`src/chat/engine.ts:79-82`) and
  `defaultPersistApproval` (`src/chat/engine.ts:307-314`), mirroring the
  lock-tolerant pattern in `src/skills/enablement.ts:16-34`.

**Why it is over-build**
A fourth observable store with a hand-rolled React hook is avoidable; the
registry idiom is already load-bearing and tested. An unnamed `persist` callback
is also a second writer to `approvals.tools` and can drift from the main gate's
write (the security report already flags the semantics at
`reports/red-team-security.md:55-73`).

**Concrete plan fix**
- Make `agents/store.ts` implement `RegistryObserver` (`subscribe` +
  `getVersion`) and delete the bespoke hook from `phase-05:56-57`; use
  `useRegistryVersion(agentStore)`.
- Name the persist owner in `phase-04` step 7: pass the session's
  `persistApproval`/`defaultPersistApproval` (`src/chat/engine.ts:79-82`,
  `:307-314`) so `allow-always` has one writer.

---

## Finding 6 — MEDIUM: Type errors are only gated at phase 6; phases 1–5 run tests that do not typecheck

**Severity:** Medium (verification gap / late failure)

**Evidence**
- `pnpm test` is bare `vitest run` — no `tsc` (`package.json:12`). The type gate
  is `pnpm build` = `tsc -b && vite build` (`package.json:9`).
- Phase 1 deletes `src/ai/sub-model.ts`, renames `ResolvedSubModel`, and changes
  the `Settings` shape (`phase-01:50-51`, `:60-77`), yet its acceptance criteria
  are only `pnpm test <three files>` + `pnpm lint` (`phase-01:99-103`). Phases 2,
  3, 4, 5 repeat the same pattern (`phase-02:86-88`, `phase-03:120-125`,
  `phase-04:117-118`, `phase-05:88-89`).
- The only full type check is phase 6 (`phase-06:70-74`).

**Why it breaks**
Every compile break from the rename/delete is invisible until the last phase,
where it lands as an unbounded pile of type errors attributed to "docs and e2e".
This makes the phase-by-phase status in the plan unverifiable: a phase can be
marked done while `pnpm build` would fail.

**Concrete plan fix**
- Add `pnpm build` (or `npx tsc -b --noEmit`) to each phase's acceptance criteria
  that changes a shared type: phase 1 (Settings/sub-model deletion), phase 3
  (new `src/agents` surface), phase 4 (`ToolRuntimePorts`).
- Keep `pnpm test` whole-suite only in phase 6, as written.

---

## Assessed and rejected (no finding raised)

- **Hidden dependency claim (prompt #4).** Phase front-matter is internally
  consistent: phase 2 `dependencies: [1]`, phase 3 `[1]`, phase 4 `[3]`, phase 5
  `[4]`, phase 6 `[2,5]` — and `[2,5]` reaches 3/1 transitively through 5→4→3.
  Phases 1 and 2 both edit `src/vault/settings.ts` (`phase-01:46`, `phase-02:43`)
  but are strictly ordered, so no parallel merge conflict exists as planned.
  One prose mismatch: `plan.md:61` says phase 3 "inherits Phase 2's settings
  shape" while `phase-03` declares `dependencies: [1]`; worth a one-line fix, not
  a blocker.
- **Adding `agents` to `ToolRuntimePorts` breaking call sites.** It is declared
  optional (`phase-04:68`, `agents?`), so existing literal constructors
  (`src/chat/engine.ts:332-349`, `src/session/session.ts:353-364`,
  `src/chat/harness-e2e.test.ts:150-157`) keep compiling. The real defect there
  is the unstated `isAvailable` and the hardcoded `builtinProviders` list
  (Finding 3), not a type break.
- **`lastModel` derivation from existing data.** `ThreadSummary` carries no
  config (`src/chat/persistence.ts:12-17`), so deriving the last-used model would
  require decrypting a thread; the small vault field is the cheaper design. Not
  an over-build.
- **README load (prompt #7).** User-facing behavior is not code-only: README is
  updated in both phase 1 (`phase-01:56`, `:86`) and phase 6 (`phase-06:41-53`),
  and the model-facing guide is added in phase 4 (`phase-04:55`, `:82-84`) via
  the existing `?raw` guide registry (`src/tools/builtin/tool-guide.ts:5-10`).

---

Status: DONE
Summary: The plan is deliverable but carries one redundant approval mechanism (the SDK already accepts an async `toolApproval` decision), a duplicated security-critical toolset resolver, and an omitted `session.test.ts`/unstated `isAvailable` that make phase 4's acceptance unverifiable; plus two dead model tiers and a type gate deferred to the final phase.
Concerns/Blockers: Finding 2 overlaps the security report's CRITICAL ordering bug — the structural fix (one shared resolver) should be applied once, not twice.
