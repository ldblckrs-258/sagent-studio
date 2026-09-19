---
title: "Harness Tools — Autonomous Core"
description: "Ten-goal harness bundle that makes the harness safe for long-horizon autonomous work: uniform result envelopes, surgical edit, bounded workspace search, offset reads, stat/move/copy, persistent sandbox sessions, approval gates, progressive skill disclosure, a thread-scoped plan tool, and conversation permission modes."
status: pending
priority: P1
effort: 48h
branch: main
tags: [feature, ai, tools, frontend, security]
created: 2026-09-19
---

# Harness Tools — Autonomous Core

## Overview

The chat engine can already call tools, run sandboxed JS/Python, and read the
granted workspace folder, but the tool surface is too thin and too blunt for
long-horizon autonomous work. Editing a file means rewriting it from memory.
Finding a symbol means listing a directory and reading every file. A failed tool
call arrives at the model as an opaque thrown error with no recovery hint.
Sandbox runs pay a cold start on every call. Destructive writes happen without a
consent step. Every enabled skill body is inlined into the system prompt, so the
prompt grows with the skill library. The model has nowhere to record a plan for a
multi-step task. Nothing caps how much autonomy a single conversation grants: every
enabled tool is equally reachable, and the only brake is a per-tool policy the user
edits in a panel.

This plan closes those ten gaps without redesigning the frozen architecture.
<!-- Updated: Scope Addendum 1 - permission modes -->
All work is additive to `ToolProvider` / `ToolRegistry` / `ToolRuntimePorts`
(`src/tools/types.ts:58`), to `WorkspaceApi` (`src/tools/types.ts:19`), to
`WorkspaceFs` (`src/workspace/fs.ts:73`), and to `SandboxSettings`
(`src/vault/settings.ts:39`).

Source research:
[sandbox persistence + workspace search](./research/researcher-02-sandbox-persistence.md)
and [AI SDK v7 approvals + assistant-ui tool primitives](./research/researcher-01-ai-sdk-approval.md).

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | `edit_file` applies an exact-string surgical patch and fails closed on a multi-match unless `replace_all` | P1 |
| 2 | `search` greps the granted workspace recursively with a regex, returns bounded `path:line:text` hits, and skips oversized and binary files | P1 |
| 3 | `read_file` gains line-based `offset`/`limit` with `truncated` and total-line metadata; `list_dir` gains `recursive` and glob filtering | P1 |
| 4 | `stat` is bound as a tool; `move` (rename) and `copy` are added | P1 |
| 5 | JS and Python sandboxes share one persistent session lifecycle with a warm worker, explicit reset, and an idle-reap timer | P1 |
| 6 | Tools that execute model-authored code or reach the network are gated by a fixed named set plus user-tool kind: `write_file`, `remove`, `edit_file`, `move`, `run_js`, `run_python`, and any user-defined tool whose kind is `sandbox-js` or `http` are gated; `make_dir`, `copy`, `list_dir`, `read_file`, `stat`, `search`, `load_skill`, `update_plan`, and `reset_sandbox` are not. The policy is persisted in the encrypted vault and answered in the assistant-ui thread | P1 | <!-- Updated: Red Team Session 1 - capability-based approval gating --> <!-- Updated: Validation Session 1 - scoped approval gating (named destructive built-ins + user sandbox-js/http) -->
| 7 | The system prompt lists skill names and descriptions only; a `load_skill` tool returns a body on demand | P1 |
| 8 | `update_plan` reads and writes a thread-scoped todo list that renders in the chat UI | P1 |
| 9 | One helper produces consistent success/failure envelopes (`code`, `message`, `hint`, `truncated`) so expected failures reach the model with a retry hint | P1 |
| 10 | Three conversation-scoped permission modes (`read_only`, `editing`, `god`) cap tool autonomy over the Phase 4 decision engine (`decision = max(modeCeiling, policy)`); a tool above the tier needs a per-call accept, the always-asking `change_mode` tool and a composer toggle switch modes, and the mode persists on `ChatThread` | P1 | <!-- Updated: Scope Addendum 1 - permission modes -->

## Contract

**Outcome.** An extended built-in tool surface plus the engine, settings, sandbox,
skill, and UI seams they need, delivered as additive changes to the existing
modules. The model can read a file region, search the workspace, patch a file in
place, move or copy an entry, stat an entry, run code in a warm sandbox, request
approval for a destructive action, load a skill body on demand, and record a
plan — and every expected failure returns a structured value the model can act on.

**Constraints.**

- Browser-only. No server, no Node APIs in app code. `pnpm build` runs `tsc -b`
  against a DOM-only `lib` (`tsconfig.app.json`), so a Node import fails the build.
- The vault `CryptoKey` never enters a worker.
- All path validation and per-operation permission checks in
  `src/workspace/fs.ts` (`resolveSegments` at `:30`, `ensurePermission` at `:57`,
  `directoryFor` at `:99`, `fileFor` at `:115`) are preserved. New operations
  route through the same helpers; no new API bypasses them.
- `ToolProvider`, `ToolRegistry`, and `ToolRuntimePorts` are extended additively.
  Existing provider names and `buildToolSet` call sites keep working.
- Secrets never appear in logs, errors, or plaintext persistence. Approval
  decisions are persisted only inside the encrypted vault settings record.
- The automated gate runs under Vitest `environment: 'node'` with injected fakes
  (`src/workspace/fake-handle.ts`, `src/sandbox/worker-factory.ts`); no real
  browser is required. Browser-only checks are recorded as named manual artifacts.
- Settings changes stay backward compatible through `deepMerge(defaultSettings(),
  data)` (`src/vault/settings.ts:108`, `:137`). New settings fields have defaults;
  a missing field in an existing vault reads as the default.
- `pnpm test`, `pnpm lint`, and `pnpm build` stay green.

**Non-goals.**

- MCP client support.
- Subagents or any parallel-agent orchestration.
- RAG ingestion, embeddings, and retrieval.
- A built-in web fetch tool.
- `pyodide.setInterruptBuffer` / cooperative interrupt. It hard-requires
  `SharedArrayBuffer`, which requires COOP/COEP response headers this app does not
  and cannot set from a `<meta>` CSP (`research/researcher-02-sandbox-persistence.md`,
  §3). `Worker.terminate()` stays the only timeout mechanism.
- Binary/image file reads through the sandbox fs bridge. `search` skips binary
  files rather than reading them; no protocol change is in scope.
- Cross-origin isolation as a deployment goal.
- Firefox/Safari parity for workspace tools (feature-detected, typed degradation).
- Neutralizing unbounded network egress from executed code, or a sandbox worker
  reading the persisted folder handle from IndexedDB. Both remain the
  user-accepted residual risks recorded in
  `plans/260919-0828-core-chat-engine/plan.md`.

**Acceptance criteria.**

1. `edit_file` on a unique `old_string` rewrites the file; on zero matches it
   returns `no_match` with a hint; on multiple matches without `replace_all` it
   returns `multiple_matches`, leaves the file byte-identical, and lists the match
   line numbers in the hint; with `replace_all` it replaces every occurrence.
2. `search` runs in a worker that is terminated on timeout, returns at most
   `maxResults` hits shaped `path:line:text`, never materializes a file above the
   2 MiB `DEFAULT_SIZE_CAP` (`src/workspace/fs.ts:24`) in the worker, skips binary
   files, rejects an invalid regex as `invalid_input`, and prunes a subtree when its
   directory handle is unreadable instead of failing the call.
   <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->
3. `read_file` with `offset`/`limit` returns the requested line window plus
   `totalLines` and `truncated`; `list_dir` with `recursive: true` returns a
   depth-first listing and with `glob` returns only matching paths. Both preserve
   the existing path rejection for `..`, backslash, drive letter, and UNC input.
4. `stat` returns `{ path, kind, size }` from `WorkspaceFs.stat`
   (`src/workspace/fs.ts:192`); `move` and `copy` work on files and directories and
   return the destination path.
5. A second `run_js` or `run_python` call reuses the same warm worker; a timeout
   terminates and respawns; `reset_sandbox` terminates both warm workers; the
   session terminates after `idleTimeoutMs` of inactivity and respawns lazily; the
   vault `CryptoKey` is not reachable from any worker.
6. A gated tool call produces a visible approval request in the assistant-ui
   thread; approving executes it, denying returns a structured `denied` result to
   the model, and `allow-always` persists the decision in the encrypted vault and
   survives reload.
7. The composed system prompt contains each enabled skill's name and description
   and none of its instructions; `load_skill` returns the body for an enabled
   skill and a structured `not_found` for a disabled or unknown one.
8. `update_plan` replaces the thread's plan; the plan persists in the encrypted
   thread record, survives reload, and renders in the chat UI; an invalid item
   returns a structured `invalid_input`.
9. Every built-in workspace, code, and http tool returns the same envelope shape;
   a thrown error reaches the model only for a runtime-unavailable condition.
10. Permission modes cap autonomy over the Phase 4 decision engine
    (`decision = max(modeCeiling, policy)`): in `read_only` (`list_dir`, `read_file`,
    `stat`, `search`, `load_skill`, `update_plan`, `change_mode`) a write or an exec
    (`write_file`, `run_js`) requires a per-call accept; in `editing` (the default)
    `remove` requires a per-call accept while the rest of the editing tier runs; in
    `god` every gated tool is auto-approved and a persisted `deny` still blocks;
    `change_mode` ALWAYS asks the user and is never auto-approved, including in
    `god`; an above-tier accept authorizes the current call only and is not
    persisted. The mode persists on `ChatThread`, survives reload, and survives a
    Config-panel save that replaces `config`.
    <!-- Updated: Scope Addendum 1 - permission modes -->
11. `pnpm test` (including the new suites), `pnpm lint`, and `pnpm build` pass.

## Key Decisions

- **Result contract first.** `src/tools/result.ts` is the single envelope source,
  built in Phase 1 before any new tool. Expected and validation failures RETURN a
  structured failure value carrying a machine-readable `code`, a human `message`,
  and a `hint` the model can retry with. Only runtime-unavailable conditions
  (`ToolRuntimeUnavailableError`, `src/tools/types.ts:84`) and unknown programming
  errors throw. Rationale: the AI SDK already converts a thrown `execute` error
  into a `tool-error` part (`research/researcher-01-ai-sdk-approval.md`, §2), but
  the thrown error loses the retry hint and the error path bypasses `toModelOutput`
  (`node_modules/ai/dist/index.js:2046-2055`). Returning a value keeps the hint.
- **`read_file`/`list_dir` stay on the main thread; `search` runs in a worker.**
  `read_file` and `list_dir` call `WorkspaceApi` on the main thread.
  `FileWorkspaceFs.search` delegates to a dedicated search worker that walks the
  tree by posting `list`/`read` calls over the existing fs bridge
  (`src/sandbox/fs-bridge.ts:11`) and matches in-worker; only path strings and
  decoded file text cross the bridge, and the workspace handle never enters the
  worker. The one-`list`-per-directory, one-`read`-per-file RPC traffic is accepted
  because it buys terminate-on-timeout: a catastrophic regex kills the worker
  instead of stalling the tab. `maxResults`/`maxFilesScanned`/`maxDepth` remain as
  secondary guards. `WorkspaceApi` and `WorkspaceFs` are extended additively; the
  2 MiB `DEFAULT_SIZE_CAP` is kept for text reads and writes.
  <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->
- **`edit_file` is read-verify-write.** It reads the file through
  `workspace.readFile`, counts exact occurrences of `old_string`, and writes only
  on a unique match (or on `replace_all`). This is a deliberate non-atomic
  read-modify-write: the File System Access API offers no compare-and-swap, so the
  window is recorded as an accepted, documented limitation with the same shape as
  the existing persisted-handle risk.
- **One sandbox session shape for both languages.** `PyRunner` already keeps a
  warm worker, serializes runs, and respawns on fatal or timeout
  (`src/sandbox/py-runner.ts:37`, `:52`, `:131`); `JsRunner` spawns a fresh worker
  per run (`src/sandbox/js-runner.ts:46`). Phase 3 promotes the `PyRunner` shape
  into a shared session abstraction and makes `JsRunner` delegate to it. JS
  per-run isolation is preserved at the compilation layer: each run is still
  compiled in its own `AsyncFunction` (`src/sandbox/js-worker.ts:86`). Module-scope
  state now persists across JS runs in a session; that is the point of the change
  and is documented as such.
- **Idle reap lives in the session, not the manager.** The session owns the worker
  handle; the manager owns rebuild and dispose (`src/sandbox/manager.ts:85`). The
  session re-arms one `setTimeout` on every activity and routes expiry through the
  same terminate path `dispose()` uses, so `activeWorkers`/`runs` bookkeeping stays
  consistent (`research/researcher-02-sandbox-persistence.md`, unresolved
  question 1). Default `idleTimeoutMs` is 300000, added to `SandboxSettings`
  (`src/vault/settings.ts:39`) and therefore to `defaultSettings()` (`:71`).
- **Native approval seam, gated by a blocking spike.** AI SDK v7 exposes a
  call-level `toolApproval` option on `streamText` (`node_modules/ai/dist/index.d.ts:5145`)
  and `UIMessage` tool parts carry `approval-requested | approval-responded |
  output-denied` states (`:2028`); assistant-ui 0.15.20 exposes
  `ToolCallMessagePartProps.approval` and `respondToApproval`, and
  `useExternalStoreRuntime` accepts `onRespondToToolApproval`
  (`research/researcher-01-ai-sdk-approval.md`, §3). The repo's converter
  (`src/chat/convert.ts:42-55`) and sanitizer (`src/chat/sanitize.ts:10`) do not
  handle those states — that is the gap. Phase 4 therefore opens with a blocking
  spike proving the request/response round-trip through `streamText` +
  `toUIMessageStream` + `useExternalStoreRuntime` in this wiring, including the
  `ignoreIncompleteToolCalls: true` interaction at `src/chat/engine.ts:113`. If the
  native pause/resume is not workable, the recorded fallback is a policy pre-check
  inside `execute` returning a structured `approval_required` result, a one-shot
  per-thread grant, and a rerun.
- **Approval gating is a named destructive set plus user code/network kinds.**
  `isGatedTool` classifies a tool by (a) a built-in destructive name list —
  `write_file`, `remove`, `edit_file`, `move`, `run_js`, `run_python` — and (b) a
  user-defined tool whose registered kind is `sandbox-js` or `http`, which is
  model-authored code or network access. `make_dir`, `copy`, `list_dir`,
  `read_file`, `stat`, `search`, `load_skill`, `update_plan`, and `reset_sandbox`
  are not gated. A pure capability rule would also gate benign mutators
  (`make_dir`, `copy`) and read tools, which is rejected scope; a pure name list
  would leave a user `sandbox-js`/`http` tool ungated, which is the real hole, so
  both clauses are required. The user-tool kind comes from the registered
  definition (`src/tools/registry.ts`).
  <!-- Updated: Red Team Session 1 - capability-based approval gating -->
  <!-- Updated: Validation Session 1 - scoped approval gating (named destructive built-ins + user sandbox-js/http) -->
- **Permission modes are a ceiling over the Phase 4 policy, stored on `ChatThread`.**
  Three conversation-scoped modes — `read_only`, `editing` (the default), and `god`
  — set the maximum autonomy for a thread. The gate computes
  `decision = max(modeCeiling, policy)`: a tool above the mode's tier escalates to a
  per-call user accept (never persisted), `god` auto-approves every gated tool, and a
  persisted `deny` always wins over both. `remove` sits above the `editing` tier, so
  it always needs an accept there. The mode lives on `ChatThread` beside
  `workspaceName` (`src/chat/types.ts:34`), NOT on `ThreadConfig`, because the Config
  panel rebuilds `config` from `threadConfigPatch` (`src/chat/config.ts:52-77`) and
  would drop it; `validateThread` (`src/chat/persistence.ts:25`) reads an absent or
  unrecognized `mode` as `editing`. `change_mode` is exempt from the ceiling and
  ALWAYS asks, even in `god`, so the model can never raise its own ceiling silently.
  The composer toggle writes the same thread-level field with no tool and no
  approval. Rationale: the Phase 4 policy is per-tool and long-lived, while the mode
  is per-conversation and quick to change; layering a ceiling over the same decision
  engine reuses one authorization path instead of adding a second.
  <!-- Updated: Scope Addendum 1 - permission modes -->
- **Per-run ports are assembled inside `buildRunStream`, not at each call site.**
  `buildRunStream` has two production call sites — `src/chat/engine.ts:292`
  (`executeRun`) and `src/chat/transport.ts:14` (`sendMessages`), with
  `src/chat/transport.test.ts` exercising the second. `PipelineDeps`
  (`src/chat/engine.ts:25`) gains optional `sandbox` and `plan` port members, and the
  per-run `ports` object at `src/chat/engine.ts:102` is the single place that merges
  them with the skill port it builds from the resolved skills. Both call sites
  inherit all three ports because the assembly happens inside `buildRunStream`, so no
  path can silently miss a port.
  <!-- Updated: Red Team Session 1 - per-run ports on PipelineDeps -->
  <!-- Updated: Red Team Session 1 - both buildRunStream call sites -->
- **Progressive disclosure at the two contract points.** `composeSystemPrompt`
  (`src/chat/context.ts:22`) stops rendering bodies and emits a name+description
  index; `SkillRegistry.toolNamesFor` (`src/skills/registry.ts:103`) keeps
  narrowing the tool pool as today, and `load_skill` is unioned in whenever at
  least one skill is enabled. Only enabled skills are addressable. Workspace
  skills stay untrusted and keep the existing delimited untrusted block.
- **`update_plan` persists on `ChatThread`, beside `workspaceName`.** The plan is a
  sibling field on `ChatThread` (`src/chat/types.ts:26`) carried through
  `validateThread` (`src/chat/persistence.ts:25`), following the same additive,
  tolerant read already used for `workspaceName` (`src/chat/persistence.ts:57`).
  It must NOT live on `ThreadConfig`: the Config panel rebuilds `config` from the
  fixed form projection in `threadConfigPatch` (`src/chat/config.ts:52-77`) and
  saves `{ ...thread, config: result.config }`
  (`src/ui/panels/chat-config.tsx:75`), which would silently drop a plan field on
  `config`. No new vault table, no envelope version bump. The tool writes through
  a per-run `ThreadPlanPort` injected into `ToolRuntimePorts`
  (`src/tools/types.ts:58`), built from the thread id and delivered through
  `PipelineDeps` so both `buildRunStream` call sites inherit it.
  <!-- Updated: Red Team Session 1 - plan lives on ChatThread, not ThreadConfig -->
- **Reuse over new abstractions.** One shared `WorkerSession` instead of two
  divergent runners. One result helper instead of per-tool error shapes. One
  `list` method with an options argument instead of a parallel `listTree`. One
  `search` implementation in a dedicated worker that reuses the existing sandbox
  fs bridge, instead of a scanner in the tool layer.
  <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Tool Result Contract and Workspace Read Primitives](./phase-01-tool-result-contract.md) | Pending |
| 2 | [Surgical Edit, Search, and File Operations](./phase-02-surgical-edit-search-and-file-ops.md) | Pending |
| 3 | [Persistent Sandbox Sessions](./phase-03-persistent-sandbox-sessions.md) | Pending |
| 4 | [Tool Approval Gates](./phase-04-tool-approval-gates.md) | Pending |
| 5 | [Progressive Skill Disclosure](./phase-05-progressive-skill-disclosure.md) | Pending |
| 6 | [Thread Plan Tool and Whole-Suite Verification](./phase-06-thread-plan-tool-and-verification.md) | Pending |

Phases are strictly sequential. Each phase's `dependencies` field lists every prior
phase, so a phase can start only after the whole chain before it is complete.

## Cross-Plan Dependencies

None. This plan is additive to
[Core Chat Engine](../260919-0828-core-chat-engine/plan.md) (`status:
implemented`), which owns the interfaces being extended: `ToolProvider` /
`ToolRegistry` / `ToolRuntimePorts`, `WorkspaceApi` / `WorkspaceFs`,
`SandboxSettings` / `defaultSettings`, `ChatThread` / `validateThread`,
`composeSystemPrompt`, `SkillRegistry`, the engine's `streamText` call, and the
`useExternalStoreRuntime` bridge. No phase of this plan changes a consumed
signature in a way that breaks an existing caller; every extension is an optional
field or an optional parameter with the previous behavior as the default.

Known existing consumers that must be re-verified when a signature changes:

- `WorkspaceApi` implementers: `FileWorkspaceFs` (`src/workspace/fs.ts:85`) and
  the inline fakes in `src/sandbox/manager.test.ts:146`,
  `src/sandbox/js-runner.test.ts:139`, `src/sandbox/py-runner.test.ts:64`.
- `ToolRuntimePorts` producers: `src/chat/engine.ts:102` (`buildRunStream`) and
  `src/session/session.ts:174` (`builtinProviders`). `builtinProviders` gains an
  optional active-thread config argument so per-run `isAvailable` is accurate in
  the Tools panel, and its only caller, `src/ui/panels/tools.tsx:190`, is updated
  to pass it.
  <!-- Updated: Validation Session 1 - config-aware builtinProviders -->
- `buildRunStream` call sites: `src/chat/engine.ts:292` (`executeRun`) and
  `src/chat/transport.ts:14` (`sendMessages`); `src/chat/transport.test.ts`
  exercises the second path. Any port or signature change must cover both.
  <!-- Updated: Red Team Session 1 - both buildRunStream call sites -->
- `SandboxSettings` readers: `src/session/session.ts:52` (`currentSandbox`) and
  `src/ui/panels/sandbox.tsx:37`.
- `composeSystemPrompt` callers: `src/chat/engine.ts:107` and
  `src/chat/context.test.ts`.
- `ToolCallMessagePartProps` consumers:
  `src/components/assistant-ui/elements/tool-fallback.aui.tsx:676`.

## Dependencies

| Relationship | Plan | Status |
|--------------|------|--------|
| Additive to | `plans/260919-0828-core-chat-engine` | implemented |
| Blocked by | none | — |

Phase order is sequential and enforced by file ownership: each phase is the sole
writer of the files it lists, and no two phases run in parallel. Phase 1 owns
`src/tools/result.ts` and `src/workspace/lines.ts`, which Phases 2, 5, and 6
import rather than reimplement; Phase 3 owns `src/sandbox/session.ts`, which
Phase 4's spike exercises; Phase 4 owns `src/chat/sanitize.ts` and the approval
seam. `src/chat/convert.ts` and `src/chat/convert.test.ts` are touched by Phase 1
(isError derivation from the envelope) and then Phase 4 (approval pass-through),
strictly in that order. `src/tools/types.ts`, `src/chat/types.ts`,
`src/chat/persistence.ts`, and `src/chat/engine.ts` are touched by more than one
phase, but always by one phase at a time, in the order listed (`src/tools/types.ts`
by Phases 2, 3, 4, 5, and 6; `src/chat/types.ts` by Phases 4 and 6;
`src/chat/persistence.ts` by Phase 4 then Phase 6; `src/chat/engine.ts` by Phases 3,
4, 5, and 6), and each edit is additive. `src/chat/threads.ts` and
`src/ui/composer-controls.tsx` are owned by Phase 4. Phase 2 additionally creates the
search worker, protocol,
and runner (`src/workspace/search-protocol.ts`, `src/workspace/search-worker.ts`,
`src/workspace/search-runner.ts`); they consume the fs bridge and must not modify
any `src/sandbox/**` file. `src/session/session.ts` and
`src/session/session.test.ts` are touched by Phases 3, 5, and 6, always by one
phase at a time in that order, and each edit is additive.
<!-- Updated: Red Team Session 1 - port phases listed; Phase 4 added to engine.ts owners -->
<!-- Updated: Validation Session 1 - search worker owned by Phase 2; session.ts shared by Phases 3/5/6 -->
<!-- Updated: Scope Addendum 1 - permission modes -->

<!-- Updated: Red Team Session 1 - convert.ts shared by Phase 1 then Phase 4; port phases listed -->


## Risk Summary

| Risk | Likelihood × impact | Mitigation |
|------|---------------------|------------|
| Native AI SDK approval pause/resume does not work in this `streamText` + `toUIMessageStream` + `useExternalStoreRuntime` wiring | Medium × High | Phase 4 opens with a blocking spike and a named manual artifact; the structured pre-check + one-shot grant + rerun fallback is designed in advance and its decision point is recorded before Phase 4 body work begins. |
| `ignoreIncompleteToolCalls: true` (`src/chat/engine.ts:113`) drops a pending approval part on the second conversion pass | Medium × High | Explicit spike test with a two-call sequence; if it drops, the recorded fallback avoids a second pass entirely. |
| Sanitizer rewrites a legitimate pending approval into an interrupted error (`src/chat/sanitize.ts:10`) | High × Medium | Phase 4 adds `approval-requested`/`approval-responded` to the paused-state set with unit tests, before wiring UI. |
| Warm JS worker leaks user `globalThis` state across runs | High × Medium | Documented behavior change plus a test asserting the session reuses one worker; `reset_sandbox` is the escape hatch. |
| Warm worker holds unbounded WASM/V8 memory (no published Pyodide RAM figure) | Medium × Medium | `idleTimeoutMs` reap and explicit reset are both in Phase 3; no RAM figure is claimed anywhere. |
| `edit_file` read-modify-write race with an external editor | Medium × Medium | Accepted, documented limitation (no compare-and-swap in the API); the tool reports the byte delta so a stale write is visible in the transcript. |
| `search` regex causes catastrophic backtracking on a large tree | Low × High | `search` runs in a dedicated worker under terminate-on-timeout, so a catastrophic pattern kills the worker instead of stalling the tab; `maxResults`/`maxFilesScanned`/`maxDepth` and the per-file text cap remain as secondary guards. A cheap regex pre-check may reject an obviously catastrophic pattern early, but it is not the mitigation of record. The `pattern` is documented as untrusted and the residual risk is recorded. <!-- Updated: Red Team Session 1 - search hard caps + regex heuristic --> <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout --> |
| Recursive `list`/`search` walks a very large tree and stalls the main thread | Medium × Medium | Recursive `list` stays on the main thread but `FileSystemDirectoryHandle.values()` iteration is async and yields; `search` walks off the main thread in a worker that issues one `list`/`read` RPC at a time through the fs bridge, bounded by `maxResults`, `maxFilesScanned`, and `maxDepth`, each reported through `truncated`. <!-- Updated: Red Team Session 1 - search hard caps --> <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout --> |
| A user `sandbox-js`/`http` tool, or a named destructive built-in, bypasses the approval gate | Medium × High | `isGatedTool` gates the named destructive built-ins (`write_file`, `remove`, `edit_file`, `move`, `run_js`, `run_python`) and any user-defined tool whose kind is `sandbox-js` or `http`. Phase 4 tests that a user `sandbox-js` tool is gated and that `make_dir`/`copy` are not. <!-- Updated: Red Team Session 1 - capability-based approval gating --> <!-- Updated: Validation Session 1 - scoped approval gating (named destructive built-ins + user sandbox-js/http) --> |
| An unrecognized error, including a rethrown `DOMException`, rejects the tool promise instead of returning a failure envelope | Medium × Medium | Phase 1's `wrapToolExecute` maps any error that is not a runtime-unavailable condition to a structured `runtime_error` envelope; only `ToolRuntimeUnavailableError` may reject the tool promise. <!-- Updated: Red Team Session 1 - failure-envelope catch-all --> |
| A failure envelope renders as a successful tool call in the UI | Medium × Medium | Phase 1 derives `isError` in `convertToolPart` from `envelope.ok === false` for `output-available` results, with a `convert.test.ts` case. <!-- Updated: Red Team Session 1 - isError from envelope.ok --> |
| `load_skill` union breaks skill `allowedTools` narrowing | Medium × Low | Explicit union rule with a registry/engine test: `load_skill` is present exactly when at least one skill is enabled, never widening any other tool. |
| Result-envelope adoption breaks existing model-facing shapes | High × Low | Intentional, in-scope contract change for item 9; `workspace.test.ts` and `code.test.ts` are updated in the same phase, and the change is called out in the phase file. |
| Approval policy persisted to the wrong place (plaintext) | Low × High | Policy lives only in the encrypted settings record via the existing vault write queue; a byte-scan test asserts no plaintext policy in IndexedDB. |
| New settings field breaks an existing vault | Medium × Medium | The field has a `defaultSettings()` default; `deepMerge` migration makes a missing field read as the default. A migration test covers a vault without the field. |

## Success Criteria

- [ ] All ten goals are implemented and each has an automated test naming the
      behavior it protects.
      <!-- Updated: Scope Addendum 1 - permission modes -->
- [ ] Acceptance criteria 1-10 are evidenced by `pnpm test`; criterion 11 is
      evidenced by a green `pnpm test`, `pnpm lint`, and `pnpm build`.
      <!-- Updated: Scope Addendum 1 - permission modes -->
- [ ] Each mode's ceiling is enforced, an above-tier accept authorizes one call
      only, `change_mode` asks in every mode including `god`, and a persisted `deny`
      still blocks in `god`; the mode survives reload and a Config-panel save.
      <!-- Updated: Scope Addendum 1 - permission modes -->
- [ ] Browser-only checks (approval round-trip in a live thread, warm-session
      reuse in a real worker, a search over a real Worker, folder-handle re-grant)
      are recorded with date, command, and observed result in a named artifact
      under `plans/260919-1821-harness-tools/reports/`.
      <!-- Updated: Validation Session 1 - search runs in a worker under terminate-on-timeout -->
- [ ] The vault `CryptoKey` is provably unreachable from a worker: no new message
      kind, port, or structured-clone path carries it.
- [ ] Path validation and per-operation permission checks are unchanged: every new
      workspace operation routes through `resolveSegments` and `ensurePermission`,
      proven by tests that pass traversal and permission-denied paths.
- [ ] An existing vault record written before this plan loads without error and
      gets every new default (no envelope version bump, no migration step).
- [ ] No plaintext approval policy, plan item, or secret is present in IndexedDB,
      proven by a byte-scan test.
- [ ] Each phase's rollback path is stated and is a pure revert of that phase's
      files; no phase leaves the suite red between phases.

## Manual Validation Artifact

Carried forward from the Core Chat Engine plan: browser-only checks are recorded
as files under `plans/260919-1821-harness-tools/reports/` with date, build hash,
browser version, command, and observed result. A phase gate marked "manual check"
without that record does not satisfy the gate. Phase 4 additionally requires its
spike report file before any Phase 4 body work is accepted.

## Red Team Review

### Session 1 — 2026-09-19
**Findings:** 22 deduplicated (22 accepted, 1 scope-framing finding rejected)
**Severity breakdown:** 3 Critical, 10 High, 9 Medium
**Reviewers:** Security Adversary (Fact Checker), Failure Mode Analyst (Flow Tracer), Assumption Destroyer (Scope Auditor), Scope & Complexity Critic (Contract Verifier)

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | Approval gate bypassed by user sandbox-js/http tools | Critical | Accept | Phase 4 |
| 2 | Plan on ThreadConfig dropped by config-panel save | Critical | Accept | plan.md, Phase 6 |
| 3 | sandbox port never reaches run path; js-worker has no port init | Critical | Accept | Phase 3 |
| 4 | Resume can duplicate assistant id / drop the tool call | High | Accept | Phase 4 |
| 5 | move/copy into a descendant self-deletes or recurses unboundedly | High | Accept | Phase 2 |
| 6 | activeRuns mitigation false for model tool runs | High | Accept | Phase 3 |
| 7 | Warm JS worker lets a prior run poison harness globals | High | Accept | Phase 3 |
| 8 | Late-answered stale approval truncates intervening turns | High | Accept | Phase 4 |
| 9 | search is unbounded and ReDoS-prone on the main thread | High | Accept | Phase 2 |
| 10 | buildRunStream second call site transport.ts omitted | High | Accept | plan.md, Phase 6 |
| 11 | Unmapped DOM errors still throw, violating the envelope contract | High | Accept | Phase 1 |
| 12 | Failure envelopes render as successful tool calls in the UI | High | Accept | Phase 1 |
| 13 | Fallback approval grant keyed on toolCallId cannot survive rerun | High | Accept | Phase 4 |
| 14 | WorkspaceApi/WorkspaceFs consumer lists incomplete | Medium | Accept | Phase 2 |
| 15 | idleTimeoutMs breaks currentSandbox() literal and session.test.ts sets | Medium | Accept | Phase 3 |
| 16 | Idle-reap semantics self-contradictory; between-runs worker errors swallowed | Medium | Accept | Phase 3 |
| 17 | reset_sandbox pair scope unspecified (tool vs console pair) | Medium | Accept | Phase 3 |
| 18 | move/copy >2 MiB text cap and empty directories unstated | Medium | Accept | Phase 2 |
| 19 | allow-always unreachable through the native approval card | Medium | Accept | Phase 4 |
| 20 | load_skill/update_plan isAvailable relies on per-run ports absent in builtinProviders() | Medium | Accept | Phase 5, Phase 6 |
| 21 | Untrusted skill name/description unbounded in system prompt; redaction claim overstated | Medium | Accept | Phase 5, Phase 1 |
| 22 | Triple plan validation, duplicated test entry, unnecessary PyRunner rewrite, e2e sprawl | Medium | Accept | Phase 3, Phase 6 |
| 23 | Glob/reset/idle/approvals-panel are unrequested scope | Medium | Reject | — (already in accepted scope; sandbox-js gating concern is Finding 1) |

### Whole-Plan Consistency Sweep
- Files reread: plan.md, phase-01-tool-result-contract.md, phase-02-surgical-edit-search-and-file-ops.md, phase-03-persistent-sandbox-sessions.md, phase-04-tool-approval-gates.md, phase-05-progressive-skill-disclosure.md, phase-06-thread-plan-tool-and-verification.md
- Decision deltas checked: plan location moved to ChatThread; capability-based gating; PipelineDeps carries per-run ports; js-worker port protocol; search caps; stale-approval expiry
- Reconciled stale references: 0
- Unresolved contradictions: 0

## Validation Log

### Validation Session 1 — 2026-09-19
Questions asked: 5 (approval scope, search safety, large-file ops, tool availability, user-tool gating)

| # | Question | Decision |
|---|----------|----------|
| 1 | Approval gating breadth | Narrow to the named destructive built-ins plus user code/network tools; do not gate `make_dir`, `copy`, or read tools. |
| 2 | Gating of user sandbox-js/http tools | Gate them: model-authored code/network tools are at least as dangerous as `run_js`. |
| 3 | Search ReDoS + unbounded walk | Run search in a worker under terminate-on-timeout; caps are secondary. |
| 4 | move/copy >2 MiB and empty directories | Add a byte-stream copy path; no text size ceiling, recreate empty directories. |
| 5 | load_skill/update_plan panel availability | Make `builtinProviders()` config-aware. |

Propagation: Phase 2 (search worker, byte-stream copy), Phase 4 (scoped gating), Phases 5/6 (config-aware providers). plan.md Goal 6 and risk rows updated.

### Whole-Plan Consistency Sweep
- Files reread: plan.md, all six phase files
- Decision deltas checked: 4 (gating scope, search execution model, copy path, provider availability)
- Reconciled stale references: 0
- Unresolved contradictions: 0

### Validation Session 2 — 2026-09-19 (scope addendum)
Questions asked: 2 (default mode, editing-tier membership)

| # | Question | Decision |
|---|----------|----------|
| 1 | Default mode | `editing`; absent field on old threads reads as `editing`. |
| 2 | Editing tier | Writes + execution + user code/network allowed; `remove` stays above the tier and requires a per-call accept. `god` auto-approves all gated tools but never auto-approves `change_mode`; a persisted `deny` still wins. |

Propagation: Goal 10 and a new acceptance criterion in plan.md; mode requirements, files, steps, and criteria in Phase 4; mode round-trip in Phase 6 verification.
