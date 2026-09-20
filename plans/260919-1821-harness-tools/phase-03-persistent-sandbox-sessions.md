---
phase: 3
title: "Persistent Sandbox Sessions"
status: implemented
priority: P1
effort: "8h"
dependencies: [1, 2]
---

# Phase 3: Persistent Sandbox Sessions

## Context Links

- Plan: [`plan.md`](./plan.md) — goal 5; Key Decisions "One sandbox session shape
  for both languages" and "Idle reap lives in the session, not the manager".
- Current JS lifecycle (fresh worker per run): `src/sandbox/js-runner.ts:46`
  (`this.workerFactory()` inside `runOnce`), `:63` (`worker.terminate()` on every
  settle), `:87` (per-run timer).
- Current Python lifecycle (already warm): `src/sandbox/py-runner.ts:29`
  (`PyRunner`), `:37` (`queue`), `:52` (`run` serialization), `:85`
  (`ensurePort` + `MessageChannel`), `:98` (`finish` with `respawn`), `:131`
  (`terminateAndRespawn`).
- Worker internals that must keep their per-run reset: `src/sandbox/js-worker.ts:13`
  (module-scope output buffers), `:81` (`handleRun` resets run state), `:86`
  (per-run `AsyncFunction` compilation); `src/sandbox/py-worker.ts:17`
  (module-scope state), `:83` (`handleRun`), `:36` (`loadPyodideOnce`).
- Protocol and serialization guard: `src/sandbox/protocol.ts:1` (`ToWorker`), `:6`
  (`FromWorker`), `:100` (`parseInbound`), `:136` (`MAX_OUTPUT_BYTES`), `:49`
  (`assertSerializable`).
- Manager ownership and rebuild: `src/sandbox/manager.ts:53` (`buildPair`), `:85`
  (`rebuild`), `:94` (`toolRunners`), `:107` (`run`), `:140` (`setSettings`), `:152`
  (`dispose`).
- Settings: `src/vault/settings.ts:39` (`SandboxSettings`), `:47` (`DEFAULT_SANDBOX_*`),
  `:71` (`defaultSettings`), `:108` (`deepMerge`).
- Composition root: `src/session/session.ts:79` (manager construction), `:102`
  (`runnerSource`), `:113` (provider registration), `:174` (`builtinProviders`).
- Panel: `src/ui/panels/sandbox.tsx:35` (`SandboxPanel`), `:39`
  (`session.sandbox()`), `:97` (runner availability row).
- Research: `research/researcher-02-sandbox-persistence.md` §1 (module-worker
  reuse, module-scope leak risk, no spec-level idle API), §2 (Pyodide state
  persists by default; full reset requires terminate + reload), §3
  (`setInterruptBuffer` unavailable without COOP/COEP).
- Test fake: `src/sandbox/worker-factory.ts` (`WorkerFactory`), and the
  `FakePortWorker` / `FakeWorker` harnesses in `src/sandbox/py-runner.test.ts:9`
  and `src/sandbox/manager.test.ts:7`.

## Goal

Give JavaScript the same warm, serialized, resettable session the Python runner
already has, and give both languages one lifecycle implementation with an explicit
reset and a bounded idle lifetime. A long-horizon agent should pay the sandbox
cold start once per session, not once per call, while the app keeps a hard stop for
a runaway run and a way to reclaim memory on demand.

## Requirements

- A new `src/sandbox/session.ts` exports `WorkerSession`, the single owner of one
  long-lived module worker per call, with:
  - one worker handle and one `MessageChannel` port, created lazily on first use;
  - a serialized queue so exactly one run is in flight at a time (required because
    `js-worker.ts` and `py-worker.ts` both keep run state at module scope, `:13`
    and `:17`);
  - a per-run timeout that on expiry rejects the run, rejects every pending
    `fs.call` promise, and calls `Worker.terminate()` followed by a lazy respawn;
  - a fatal-result path (a `FromWorker` result carrying `fatal: true`, produced by
    `py-worker.ts:91`) that terminates and lazily respawns;
  - an inbound-message `runId` filter that ignores a message for an unknown or
    settled run;
  - an activity-rearmed idle timer.
- `JsRunner` (`src/sandbox/js-runner.ts`) and `PyRunner` (`src/sandbox/py-runner.ts`)
  keep their public class names, constructor option shapes (`workerFactory`,
  `workspace`, `defaultTimeoutMs`), `run(source, options)` signature, and `dispose()`
  method, and become thin wrappers over `WorkerSession`. Any existing import site
  keeps compiling.
- `PyRunner` behavior must stay byte-identical. Do NOT rewrite its result handling:
  extract only the lifecycle that is genuinely shared (lazy spawn, one port,
  serialized queue, timeout/fatal respawn, idle timer) and let `PyRunner` delegate
  to it. `JsRunner` adopts the warm, serialized, fatal-respawn shape. Any change to
  PyRunner's observable result requires a failing-first test proving the change is
  needed; there is no mandate to touch it otherwise.
  <!-- Updated: Red Team Session 1 - PyRunner behavior preserved -->
- `src/sandbox/js-worker.ts` must convert to the port protocol explicitly, because a
  warm JS run currently has no port to answer on: accept an `init` message, store the
  transferred `MessagePort`, and post `result`/`fatal` over that port, mirroring
  `src/sandbox/py-worker.ts:142-150`. Without this conversion a warm JS run hangs
  waiting for a result that is still posted to the one-shot channel. A real-worker
  smoke test covers it in addition to the fake.
  <!-- Updated: Red Team Session 1 - js-worker port protocol -->
- `SandboxSettings` gains `idleTimeoutMs: number` with
  `DEFAULT_SANDBOX_IDLE_TIMEOUT_MS = 300_000`, added to `defaultSettings()`. An
  existing vault without the field reads the default through `deepMerge`
  (`src/vault/settings.ts:137`). `SETTINGS_VERSION` is not bumped.
- `SandboxManager` gains
  `reset(language?: SandboxLanguage, scope: 'tool' | 'console' = 'tool'): void`,
  terminating and lazily respawning the selected runner in the selected pair (both
  languages when `language` is omitted). `setSettings` also rebuilds when
  `idleTimeoutMs` changes, using the existing deferred-rebuild path
  (`src/sandbox/manager.ts:131-137`).
  <!-- Updated: Red Team Session 1 - reset_sandbox pair scope -->
- A `reset_sandbox` tool is registered from a new
  `src/tools/builtin/sandbox-control.ts` provider with names `['reset_sandbox']`.
  It resets both languages by default and reports which were reset. Its scope is
  explicit: the model tool resets the workspace-bound `toolPair`
  (`src/sandbox/manager.ts:79`); the sandbox-panel button resets the file-less
  `consolePair` (`:80`). A reset must never terminate the other pair's warm worker.
  <!-- Updated: Red Team Session 1 - reset_sandbox pair scope -->
- `ToolRuntimePorts` gains an optional `sandbox?: SandboxControlPort` with
  `reset(language?: 'js' | 'python'): void` and
  `status(): { js: boolean; python: boolean }`. It stays optional, so every
  existing ports object still satisfies the interface. The port is bound to the
  workspace-bound `toolPair`; the panel button does not use it.
  <!-- Updated: Red Team Session 1 - reset_sandbox pair scope -->
- The sandbox panel gains a "Reset session" button wired to
  `session.sandbox()?.reset(undefined, 'console')`, so it resets the file-less
  `consolePair` the console uses; it is disabled while a run is in flight or when
  the manager is absent.
  <!-- Updated: Red Team Session 1 - reset_sandbox pair scope -->
- Model-initiated runs must be visible to the manager's in-flight accounting.
  Today model tools call `runner.run` directly and bypass `manager.run`
  (`src/session/session.ts:128-130` returns the raw runner to
  `src/tools/builtin/code.ts:50`), so `activeRuns` (`src/sandbox/manager.ts:121`)
  never sees them and the deferred rebuild could terminate a live model run. The
  tool-facing runner pair is wrapped so each `run` increments and decrements the
  same in-flight counter the manager consults, preserving the runner's direct
  `SandboxTimeoutError` contract. The deferred-rebuild check is then correct for
  both console and model runs.
  <!-- Updated: Red Team Session 1 - model runs in manager in-flight accounting -->
- The idle timeout has no UI control in this phase. It is persisted configuration
  with a default; adding a panel field is an explicit non-goal here.
- `js-worker.ts` and `py-worker.ts` install `error` and `unhandledrejection`
  listeners on `self` so a persistent worker does not die silently between runs
  (`research/researcher-02-sandbox-persistence.md` §1). They keep resetting their
  module-scope run state at the start of every run.
- A worker error that arrives BETWEEN runs cannot be attributed to a run, so it is
  reported with an explicit session-fatal protocol message (session-scoped, carrying
  no per-run `runId`), not through the per-run `postResult` path. On receipt the
  session terminates the worker and respawns lazily; it does not try to route the
  error into a completed run's result.
  <!-- Updated: Red Team Session 1 - session-fatal protocol message -->
- The JS worker snapshots the harness intrinsics it needs for result reporting
  (`JSON.stringify`, `postMessage`, `TextEncoder`, and the port reference) at init,
  so a prior run cannot poison them. `reset_sandbox` restores user `globalThis` and
  module scope, but does NOT contain prototype poisoning of shared intrinsics; that
  boundary is stated rather than implied.
  <!-- Updated: Red Team Session 1 - snapshot harness intrinsics -->
- JS per-run isolation at the compilation layer is preserved: each run is still
  compiled in its own `AsyncFunction` in `handleRun` (`js-worker.ts:86`). The change
  is that module-scope and `globalThis` state now survive between runs in one
  session, which is the intended behavior and is documented and tested.
- Timeout remains `Worker.terminate()`. No `SharedArrayBuffer`, no
  `setInterruptBuffer`, no cross-origin-isolation assumption.
- The vault `CryptoKey` never enters a worker; no new message kind carries it.

## Architecture

**One session, two languages.** `WorkerSession` is constructed with a
`WorkerFactory`, an optional `WorkspaceApi`, a `defaultTimeoutMs`, and an
`idleTimeoutMs`. State: `worker | null`, `port | null`, `runs: Map<runId, RunEntry>`,
`runCounter`, `queue: Promise<unknown>`, `idleTimer`. The `PyRunner` shape moves in
verbatim: `ensurePort()` (`py-runner.ts:85`) becomes the session's lazy spawn,
`finish(entry, respawn)` (`:98`) becomes the settle path, and
`terminateAndRespawn()` (`:131`) becomes `terminate()`. `JsRunner` drops
`activeWorkers: Set<Worker>` and its per-run `addEventListener`/`removeEventListener`
dance in favor of the same port-based dispatch.

**Run sequencing.**

```
run() → queue.then(execute, execute)          // one run at a time
      → ensurePort()                           // lazy spawn + MessageChannel init
      → runs.set(runId, entry) + arm timeout
      → port.postMessage({ kind: 'run', runId, language, source })
      → dispatch(inbound):
           fs.call  → attachFsHandler(...)     // unchanged bridge, per-run pendingFs
           result   → settle(entry); respawn if fatal
      → timeout: reject pending fs calls → terminate() → reject run
```

The `fs.call` bridge (`src/sandbox/fs-bridge.ts:11`, `:25`) is unchanged: it already
takes a `pendingFs` set and a `safePost` callback, which is exactly what the session
provides. The workspace-bound and file-less runners stay two separate sessions, as
they are two separate runner pairs today (`src/sandbox/manager.ts:53`).

**Activity and idle reap.** `idleTimeoutMs` is a settings value, not a session
constant. Every `run()` call and every inbound message clears and re-arms one
`setTimeout`. On expiry the session terminates the worker, clears the port, rejects
every unsettled run and every pending `fs.call`, and empties the run map, with no
respawn; expiry routes through the same terminate function `dispose()` uses, so
bookkeeping is consistent. The next `run()` respawns lazily through `ensurePort()`
and re-arms the timer. A new run therefore always restarts the idle clock, and a run
that stays silent past the deadline is terminated and rejected rather than left
running.
<!-- Updated: Red Team Session 1 - idle-reap semantics resolved -->

**Reset.** `reset()` is terminate-now with no queued respawn. `dispose()` in the
runners maps to `reset()`; the manager's `rebuild()` (`:85`) already calls
`dispose()` on every runner and constructs fresh ones, so behavior there is
preserved. `reset_sandbox` calls the manager's `reset()` scoped to the
workspace-bound `toolPair`; the panel button calls it scoped to the `consolePair`.
Each pair's reset leaves the other pair's warm worker untouched.
<!-- Updated: Red Team Session 1 - reset_sandbox pair scope -->

**Settings propagation.** `session.ts:95-99` already subscribes to sandbox settings
and calls `manager.setSettings(next)`. `setSettings` compares timeouts today
(`:141`); it gains `idleTimeoutMs` in the comparison and forwards the value into
`buildPair`. No new subscription is needed.

**Reset cost.** A Python reset is a full Pyodide reload (wasm ~9.15 MiB plus
stdlib); a JS reset is a fresh module worker. No resident-memory figure is claimed
because none is published for this Pyodide version
(`research/researcher-02-sandbox-persistence.md` §2 and its UNVERIFIED list). The
tool result states only what happened, not an estimate.

## Files to Create / Modify

Create:

- `src/sandbox/session.ts` — `WorkerSession`, `DEFAULT_IDLE_TIMEOUT_MS` re-export
  point, `WorkerSessionOptions`.
- `src/sandbox/session.test.ts`
- `src/tools/builtin/sandbox-control.ts` — `createSandboxControlProvider(source)`.
- `src/tools/builtin/sandbox-control.test.ts`

Modify:

- `src/sandbox/js-runner.ts` — delegate to `WorkerSession`; keep exports
  `JsRunner`, `DEFAULT_JS_TIMEOUT_MS`, `defaultJsWorkerFactory`,
  `SandboxRunnerOptions`; add `idleTimeoutMs` to the options.
- `src/sandbox/py-runner.ts` — delegate to `WorkerSession`; keep exports
  `PyRunner`, `DEFAULT_PY_TIMEOUT_MS`, `defaultPyWorkerFactory`, `PyRunnerOptions`;
  add `idleTimeoutMs`. Result behavior stays byte-identical; do not rewrite result
  handling.
  <!-- Updated: Red Team Session 1 - PyRunner behavior preserved -->
- `src/sandbox/js-worker.ts` — convert to the port protocol: accept `init`, store the
  transferred `MessagePort`, and post `result`/`fatal` over it (mirror
  `src/sandbox/py-worker.ts:142-150`); snapshot the result-reporting intrinsics at
  init; add `error`/`unhandledrejection` listeners that emit the session-fatal
  message.
  <!-- Updated: Red Team Session 1 - js-worker port protocol -->
- `src/sandbox/py-worker.ts` — add `error` and `unhandledrejection` listeners on
  `self` that emit the session-fatal message; its result handling is otherwise
  unchanged.
  <!-- Updated: Red Team Session 1 - session-fatal protocol message -->
- `src/sandbox/manager.ts` — `reset(language?, scope)` on the interface and the
  implementation; wrap the tool pair's `run` so model runs share the in-flight
  counter; pass `idleTimeoutMs` into `buildPair`; include `idleTimeoutMs` in the
  `setSettings` change check.
  <!-- Updated: Red Team Session 1 - model runs in manager in-flight accounting -->
- `src/vault/settings.ts` — `idleTimeoutMs` on `SandboxSettings`,
  `DEFAULT_SANDBOX_IDLE_TIMEOUT_MS`, and the `defaultSettings()` value.
- `src/tools/types.ts` — `SandboxControlPort`, optional `sandbox` on
  `ToolRuntimePorts`.
- `src/chat/engine.ts` — add `sandbox?: SandboxControlPort` to `PipelineDeps` and
  include it in the `buildRunStream` `ports` object at `:102`, so both call sites
  inherit it.
  <!-- Updated: Red Team Session 1 - per-run ports on PipelineDeps -->
- `src/chat/transport.ts`, `src/chat/transport.test.ts` — the second
  `buildRunStream` call site (`:14`); confirm the inherited sandbox port reaches the
  run and add a transport-level assertion.
  <!-- Updated: Red Team Session 1 - both buildRunStream call sites -->
- `src/session/session.ts` — register the sandbox-control provider and supply the
  port from the manager; add `idleTimeoutMs: DEFAULT_SANDBOX_IDLE_TIMEOUT_MS` to the
  `currentSandbox()` fallback literal (`:52-59`); include the tool names in
  `builtinProviders()`.
  <!-- Updated: Red Team Session 1 - currentSandbox fallback literal -->
- `src/ui/panels/sandbox.tsx` — the "Reset session" button, scoped to `consolePair`.
- `src/sandbox/js-runner.test.ts`, `src/sandbox/py-runner.test.ts`,
  `src/sandbox/manager.test.ts` — update for warm-worker semantics; add
  `idleTimeoutMs` to the `SETTINGS` fixture; add a real-worker smoke test for the JS
  port protocol and a test that a settings change does not kill a live model run.
  <!-- Updated: Red Team Session 1 - js-worker port protocol -->
- `src/session/session.test.ts` — update the exact `availableNames({})`
  expectations (`:34`, `:38`, `:50`, `:52`) for the new `reset_sandbox` provider.
  <!-- Updated: Red Team Session 1 - session.test.ts expectations -->
- `src/vault/settings` tests (whichever file covers `defaultSettings`/`migrate`) —
  assert the new default and a migration read of a record without the field.

Do not modify: `src/skills/**`, `src/workspace/**`, `src/tools/result.ts`,
`src/tools/builtin/workspace.ts`, `src/tools/builtin/code.ts`, and
`src/chat/**` except `src/chat/engine.ts` and `src/chat/transport.ts` /
`src/chat/transport.test.ts`.
<!-- Updated: Red Team Session 1 - scoped src/chat exception -->

## Test Plan

Unit — `src/sandbox/session.test.ts` (using the `FakePortWorker` harness pattern
from `src/sandbox/py-runner.test.ts:9`)

- Two sequential runs create exactly one worker and reuse its port.
- Two concurrent runs are serialized: the second `postMessage` is not sent until
  the first settles.
- A timeout rejects the run with `SandboxTimeoutError`, rejects every pending
  `fs.call`, and terminates the worker; the next run creates a second worker.
- A fatal result terminates the worker and the next run respawns.
- An inbound message with a mismatched `runId` is ignored.
- An idle interval longer than `idleTimeoutMs` terminates the worker; a subsequent
  run lazily respawns exactly one new worker.
- Activity re-arms the timer: a run at `idleTimeoutMs - 1` keeps the same worker
  alive past the original deadline.
- A run that stays silent past the deadline is terminated and rejected with its
  pending `fs.call` rejected; the next run re-arms the timer and respawns.
  <!-- Updated: Red Team Session 1 - idle-reap semantics resolved -->
- A session-fatal message received BETWEEN runs terminates the worker and the next
  run respawns, rather than the error being routed into a completed run.
  <!-- Updated: Red Team Session 1 - session-fatal protocol message -->
- `reset()` terminates a warm worker and rejects an in-flight run; the next run
  respawns.

Unit — `src/sandbox/js-runner.test.ts`

- A second run reuses the worker (replaces the current
  `expect(worker.terminated).toBe(true)` after a single run, `:65`).
- Output capping still applies at 64 KiB.
- Timeout still terminates and rejects, and the following run respawns.
- `fs.call` still routes through the workspace.
- `dispose()` still terminates; a late inbound message is not posted to.
- `idleTimeoutMs` is honored when supplied.
- A real-worker smoke test (the actual `js-worker.ts`, not the fake) completes two
  warm runs, proving the `init`/port conversion works and the second run does not
  hang.
  <!-- Updated: Red Team Session 1 - js-worker port protocol -->
- A prior run mutating a harness intrinsic does not corrupt the next run's result
  reporting, because the worker snapshots `JSON.stringify`/`postMessage` at init.
  <!-- Updated: Red Team Session 1 - snapshot harness intrinsics -->

Unit — `src/sandbox/py-runner.test.ts`

- The existing warm-reuse, fatal-respawn, serialization, and pending-RPC tests keep
  passing against the session-backed implementation.
- `idleTimeoutMs` is honored.

Unit — `src/sandbox/manager.test.ts`

- `reset('js', 'tool')` terminates the tool pair's JS worker and leaves the console
  pair untouched; `reset('js', 'console')` does the reverse.
  <!-- Updated: Red Team Session 1 - reset_sandbox pair scope -->
- `reset(undefined, 'tool')` terminates both tool-pair runners only.
- A `setSettings` change to `idleTimeoutMs` rebuilds when idle and defers while a
  run is in flight, matching the existing timeout test at `:115`.
- A model-style run through the tool pair's wrapped `run` counts as in flight, so a
  settings change defers instead of terminating the live worker.
  <!-- Updated: Red Team Session 1 - model runs in manager in-flight accounting -->
- An unchanged `idleTimeoutMs` write does not rebuild.

Unit — `src/tools/builtin/sandbox-control.test.ts`

- The provider contributes exactly `['reset_sandbox']` and is unavailable when the
  sandbox is disabled.
- `reset_sandbox` with no argument resets both languages and returns
  `{ reset: ['js', 'python'] }` inside a success envelope.
- `reset_sandbox` with `{ language: 'python' }` resets only Python.
- An unknown language value returns `invalid_input`.
- There is no runtime port → `ToolRuntimeUnavailableError` still throws.

Settings

- `defaultSettings().sandbox.idleTimeoutMs` is `300000`.
- `migrate(1, { sandbox: { enabled: true, jsTimeoutMs: 1000, pyTimeoutMs: 2000 } })`
  yields `idleTimeoutMs: 300000`.

Integration

- `src/session/session.ts` composition: `builtinProviders()` includes
  `reset_sandbox` with `available: true` for an enabled sandbox.
- `src/session/session.test.ts` updates the exact `availableNames({})` expectations
  (`:34`, `:38`, `:50`, `:52`) to include `reset_sandbox`.
  <!-- Updated: Red Team Session 1 - session.test.ts expectations -->

## Implementation Steps

1. Write `src/sandbox/session.ts` by lifting `PyRunner`'s internals: port creation
   from `py-runner.ts:85`, the run entry and timer from `:59-83`, the settle path
   from `:98-104`, dispatch from `:106-129`, and terminate from `:131-149`. Add the
   idle timer and `reset()`. Keep the `ToWorker`/`FromWorker` types and
   `parseInbound` untouched.
2. Write `src/sandbox/session.test.ts` against the `FakePortWorker` pattern and run
   `pnpm test src/sandbox/session.test.ts`.
3. Rewrite `JsRunner` as a session wrapper, then `PyRunner`. Keep every exported
   name and the constructor option shapes. `PyRunner`'s result handling is preserved
   byte-identical; only its lifecycle delegates. Run their tests and update the two
   assertions that encode "terminate on settle".
   <!-- Updated: Red Team Session 1 - PyRunner behavior preserved -->
4. Convert `js-worker.ts` to the port protocol (accept `init`, store the transferred
   `MessagePort`, post `result`/`fatal` over it, mirroring `py-worker.ts:142-150`) and
   snapshot the result-reporting intrinsics at init. Add the
   `error`/`unhandledrejection` listeners to both workers; emit the session-fatal
   message (session-scoped, no `runId`) rather than routing a between-runs error
   through `postResult`. Add the real-worker smoke test.
   <!-- Updated: Red Team Session 1 - js-worker port protocol + session-fatal -->
5. Add `idleTimeoutMs` to `SandboxSettings` plus `DEFAULT_SANDBOX_IDLE_TIMEOUT_MS`
   and `defaultSettings()`. Run the settings tests.
6. Extend `SandboxManager`: `reset(language?, scope)`, wrap the tool pair's `run` so
   model runs share the in-flight counter, `idleTimeoutMs` into `buildPair`, and the
   `setSettings` comparison. Update `manager.test.ts` and its `SETTINGS` fixture.
   <!-- Updated: Red Team Session 1 - model runs in manager in-flight accounting -->
7. Add `SandboxControlPort` and the optional `sandbox` member to
   `ToolRuntimePorts` (`src/tools/types.ts:58`). Write
   `src/tools/builtin/sandbox-control.ts` with `NAMES = ['reset_sandbox']`, an
   `isAvailable` that follows `source.isEnabled()`, and an `execute` that returns a
   success envelope listing reset languages.
8. Register the provider in `src/session/session.ts` and supply the port from the
   manager (`status()` from `manager.availability()`, `reset()` bound to the
   `toolPair`). Add `idleTimeoutMs: DEFAULT_SANDBOX_IDLE_TIMEOUT_MS` to the
   `currentSandbox()` fallback literal (`:52-59`). Extend `builtinProviders()` so the
   Tools panel shows the new tool, and update the `availableNames({})` expectations
   in `src/session/session.test.ts` (`:34`, `:38`, `:50`, `:52`).
   <!-- Updated: Red Team Session 1 - currentSandbox fallback literal + session.test.ts expectations -->
9. Add the "Reset session" button to `src/ui/panels/sandbox.tsx`, disabled while
   `running` or when `manager` is null, calling
   `manager.reset(undefined, 'console')` so it resets the `consolePair`, and clearing
   the current result.
   <!-- Updated: Red Team Session 1 - reset_sandbox pair scope -->
10. Run `pnpm test`, then `pnpm lint` and `pnpm build`.
11. Record the browser-only confirmation that a warm JS worker is reused and that
    reset/reap reclaim it, as a report under
    `plans/260919-1821-harness-tools/reports/`.

## Todo

- [ ] `src/sandbox/session.ts` with lazy spawn, serialized queue, fatal respawn,
      pending-RPC rejection, idle reap, and `reset()`
- [ ] `session.test.ts` green for reuse, serialization, timeout, fatal, idle,
      re-arm, crossing-deadline reap, between-runs session-fatal, and reset
- [ ] `JsRunner` delegates to the session; exported names unchanged
- [ ] `PyRunner` delegates to the session with byte-identical result behavior
      <!-- Updated: Red Team Session 1 - PyRunner behavior preserved -->
- [ ] `js-worker.ts` accepts `init`, stores the transferred port, posts
      `result`/`fatal` over it, and snapshots result-reporting intrinsics at init
      <!-- Updated: Red Team Session 1 - js-worker port protocol -->
- [ ] In-worker `error` / `unhandledrejection` handlers in both workers, emitting
      the session-fatal message rather than `postResult`
      <!-- Updated: Red Team Session 1 - session-fatal protocol message -->
- [ ] `SandboxSettings.idleTimeoutMs` + default + `defaultSettings()` value +
      `currentSandbox()` fallback literal
      <!-- Updated: Red Team Session 1 - currentSandbox fallback literal -->
- [ ] `SandboxManager.reset(language?, scope)` with pair scoping, model runs counted
      as in flight, and `idleTimeoutMs` in the rebuild check
      <!-- Updated: Red Team Session 1 - model runs in manager in-flight accounting -->
- [ ] `SandboxControlPort` on `ToolRuntimePorts` and `reset_sandbox` provider bound
      to `toolPair`
- [ ] Provider registered in `src/session/session.ts`, `builtinProviders()` and
      `session.test.ts` expectations updated
- [ ] "Reset session" button in `src/ui/panels/sandbox.tsx`, scoped to `consolePair`
- [ ] `src/chat/engine.ts` gains `PipelineDeps.sandbox` and the `:102` ports entry;
      `transport.ts` / `transport.test.ts` cover the second call site
      <!-- Updated: Red Team Session 1 - both buildRunStream call sites -->
- [ ] Runner/manager/settings tests updated for warm-worker semantics, with a
      real-worker JS smoke test
- [ ] Browser-only warm-session and reset confirmation recorded as a report
- [ ] `pnpm test`, `pnpm lint`, `pnpm build` green

## Success Criteria

- [ ] A second `run_js` or `run_python` in the same session reuses the same worker,
      proven by a test asserting exactly one factory call across two runs.
- [ ] Two concurrent runs never overlap on one worker, proven by an ordering
      assertion.
- [ ] A timeout terminates the worker, rejects every pending `fs.call`, and the
      next run respawns.
- [ ] A fatal worker result terminates and respawns.
- [ ] An idle period longer than `idleTimeoutMs` terminates the worker with no
      respawn until the next run, and a run that crosses the deadline is terminated
      and rejected.
      <!-- Updated: Red Team Session 1 - idle-reap semantics resolved -->
- [ ] A warm JS run completes over the real worker's `init`/port protocol; the
      second run does not hang.
      <!-- Updated: Red Team Session 1 - js-worker port protocol -->
- [ ] A between-runs worker error terminates the session and respawns lazily rather
      than being routed into a completed run.
      <!-- Updated: Red Team Session 1 - session-fatal protocol message -->
- [ ] `reset_sandbox` returns which languages were reset, is unavailable when the
      sandbox is disabled, and resets only the workspace-bound `toolPair`; the panel
      button resets only the `consolePair`.
      <!-- Updated: Red Team Session 1 - reset_sandbox pair scope -->
- [ ] A model-initiated run is counted in the manager's in-flight accounting, so a
      settings change defers rather than terminating it.
      <!-- Updated: Red Team Session 1 - model runs in manager in-flight accounting -->
- [ ] `PyRunner` results are byte-identical to before this phase.
      <!-- Updated: Red Team Session 1 - PyRunner behavior preserved -->
- [ ] The panel reset button is disabled during a run.
- [ ] A vault record without `idleTimeoutMs` loads with `300000` and no version
      bump.
- [ ] No code path references `SharedArrayBuffer`, `crossOriginIsolated`, or
      `setInterruptBuffer`.
- [ ] `pnpm test`, `pnpm lint`, and `pnpm build` pass.

## Risk Assessment

| Risk | Likelihood × impact | Mitigation |
|------|---------------------|------------|
| Warm JS worker leaks `globalThis` or module-scope state across runs | High × Medium | Intended behavior, documented in the phase and the tool description; a test asserts one worker across runs; `reset_sandbox` is the escape hatch. Not treated as a bug. |
| A persistent worker dies between runs and every later run fails silently | Medium × High | In-worker `error`/`unhandledrejection` handlers emit the session-fatal protocol message; the session terminates and respawns lazily. A per-run `fatal` result still terminates and respawns. <!-- Updated: Red Team Session 1 - session-fatal protocol message --> |
| Idle reap fires during an in-flight run | Medium × High | The timer is re-armed on `run()` entry and on every inbound message, so a normally active run never reaches expiry. If a run is silent past the deadline, expiry terminates the worker and rejects the run and its pending `fs.call`s through the same terminate path; the next run re-arms the timer and respawns. A test covers a run that crosses the deadline. <!-- Updated: Red Team Session 1 - idle-reap semantics resolved --> |
| A settings change to `idleTimeoutMs` kills a live run | Medium × Medium | `setSettings` reuses the existing `activeRuns`/`rebuildPending` deferral (`src/sandbox/manager.ts:131-137`). That deferral is only correct once model runs are counted too: model tools call `runner.run` directly (`src/tools/builtin/code.ts:50`) and bypass `manager.run` (`manager.ts:121`), so this phase wraps the tool pair's `run` to share the in-flight counter. A test asserts a live model run is not terminated by a settings change. <!-- Updated: Red Team Session 1 - model runs in manager in-flight accounting --> |
| Python reset cost surprises a user mid-task | Medium × Low | Reset is explicit and user- or model-initiated; the tool result names the languages reset. No reset happens implicitly except through the idle reap while idle. |
| Losing the per-run `addEventListener` path drops a message | Low × Medium | The `MessageChannel` port is created once and `port.start()` is called, matching the proven `PyRunner` path; the existing manager and runner tests cover the bridge. |
| Adding a required `reset` to `SandboxManager` breaks an implementer | Medium × Low | The manager is constructed in exactly one place outside tests (`src/session/session.ts:79`); the test doubles in `manager.test.ts` and `session` tests are updated here. The `scope` parameter defaults to `'tool'`, so a single-argument call still compiles. <!-- Updated: Red Team Session 1 - reset_sandbox pair scope --> |
| `idleTimeoutMs` on an old vault is `undefined` and disables the reap | Medium × Low | `deepMerge` fills it from `defaultSettings()`; the session also treats a non-positive or missing value as `DEFAULT_SANDBOX_IDLE_TIMEOUT_MS`, covered by a migration test. |

**Rollback.** Revert this phase's files. The two runners return to their previous
implementations, the setting disappears with its default, and the new tool stops
being registered. No persisted message or thread format changes, so no data
rollback is needed; an existing vault containing `idleTimeoutMs` still loads
because `deepMerge` ignores unknown-to-the-old-code fields only by omission, and the
field is simply unused. Phase 4 is unaffected because it does not depend on the
session shape.

## Security Considerations

- The vault `CryptoKey` still never enters a worker. No message kind, transferable,
  or port carries it, and `assertSerializable` (`src/sandbox/protocol.ts:49`) still
  rejects a `SharedArrayBuffer` and a `Blob`.
- A persistent worker extends the lifetime of the already-accepted residual risk
  (page-equivalent network reach and IndexedDB access from a same-origin worker).
  That risk is documented in the parent plan; this phase does not widen it and adds
  the idle reap, which bounds the exposure window rather than extending it.
- Output is still capped at `MAX_OUTPUT_BYTES` per run (`src/sandbox/protocol.ts:136`).
- The idle timer is cleared on `dispose()` and `reset()` so a session cannot
  respawn a worker after the vault locks or the workspace changes.
- `reset_sandbox` accepts no path or code input, so it adds no injection surface;
  an unknown `language` is rejected as `invalid_input` before any call.

## Next Steps

Phase 4's approval spike needs a deterministic way to trigger a gated tool call
without a live model provider. The session's injectable `WorkerFactory` and the
existing `MockLanguageModelV4` seam (`src/chat/engine.test.ts:78`) give the spike
both halves.
