---
phase: 6
title: "Sandbox Panel"
status: implemented (browser gate pending)
priority: P2
effort: "7h"
dependencies: [1, 5]
---

# Phase 6: Sandbox Panel

## Goal

Add a sandbox panel that persists enablement and default JS/Python timeouts,
reports runner availability, and offers a scratchpad console that runs code and
shows stdout, result, and errors.

## Context

- `CodeRunner` is `{ run(source, { timeoutMs? }): Promise<RunResult> }` and
  `RunResult` is `{ stdout, stderr, result: string | null, error?: string }`
  (`src/sandbox/types.ts:5-14`).
- `JsRunner` defaults to `DEFAULT_JS_TIMEOUT_MS = 10_000` and takes
  `{ workerFactory?, workspace?, defaultTimeoutMs? }`
  (`src/sandbox/js-runner.ts:9`, `:14-30`); `defaultJsWorkerFactory` constructs a
  module worker (`:11-12`).
- `PyRunner` defaults to `DEFAULT_PY_TIMEOUT_MS = 30_000`, keeps a warm worker,
  and serializes runs because the worker holds per-run module state
  (`src/sandbox/py-runner.ts:9`, `:39-52`).
- Both runners truncate output through `truncateOutput` (64 KB) before resolving
  (`src/sandbox/js-runner.ts:68-69`, `src/sandbox/py-runner.ts:117-120`), and both
  attach a workspace RPC handler when `workspace` is provided
  (`src/sandbox/js-runner.ts:62-64`).
- `Settings` has no sandbox slice (`src/vault/settings.ts:30-37`): no enablement
  and no default timeouts. `deepMerge` tolerates additive fields without a version
  bump (`:76-91`).
- There is no factory that builds runners from settings, no status surface, and no
  last-run record (research 02 §6 sandbox row).
- `createCodeToolProvider(runners)` is registered in Phase 1's session and its
  `isAvailable` is always true (`src/tools/builtin/code.ts:32`), so the enabled
  toggle is the app-level gate rather than a provider-level one.
- Worker availability in this codebase is `typeof Worker !== 'undefined'`; the
  runner classes themselves do not check it
  `[UNVERIFIED]` (no such check was found in `src/sandbox/js-runner.ts` or
  `src/sandbox/py-runner.ts`).
- The brainstorm scoped the panel as config + status + scratchpad and left the
  scratchpad's workspace access unresolved (`brainstorm-260919-2129-…md:196-202`,
  `:242-243`).
- House motion and controls: `panel-in` (`src/index.css:196-205`), `min-h-11`
  buttons (`src/ui/primitives.tsx:30`), `Row`/`Field` for form structure.

## Requirements

Functional:

- `Settings.sandbox` is additive: `{ enabled: boolean; jsTimeoutMs: number;
  pyTimeoutMs: number }`, with defaults matching the runner constants (10 000 and
  30 000). `defaultSettings()` gains the slice, `migrate` needs no change, and
  no version bump occurs. `Settings` is a required shape, so the fixtures that
  build one must be updated: `src/vault/test-fixtures.ts:37` and the exact-equality
  assertion at `src/vault/store.test.ts:221` (red-team finding 4).
- `src/sandbox/manager.ts` exports a factory that owns the runner instances and
  exposes them through a **stable holder object** so a settings rebuild is visible
  to already-registered consumers without re-registration (findings 1, 9). It also
  exposes availability and a last-run record.
- The manager owns two runner sets: a workspace-bound pair for the model-facing
  tools (the same `WorkspaceApi` the session holds) and a **file-less** pair for
  the scratchpad console. A single pair cannot satisfy both requirements
  (red-team finding 14).
- `JsRunner` and `PyRunner` gain a public `dispose()` that terminates their worker;
  `PyRunner.terminateAndRespawn` is private today
  (`src/sandbox/py-runner.ts:126`), so without a dispose a settings change orphans
  the warm Pyodide worker (finding 9).
- The manager accepts an injected `WorkerFactory` for both runners so its
  logic is unit-testable without a browser.
- The panel shows an enable toggle, JS and Python timeout inputs validated as
  positive finite integers within a sane upper bound, runner availability, and a
  scratchpad with a language picker, a source textarea, a Run button, and an
  output area showing `stdout`, `stderr`, `result`, and `error`.
- The Run button is disabled when `sandbox.enabled` is false or a run is in
  flight; the output area shows the last result and the last error.
- The scratchpad defaults to the file-less console pair and offers a per-session
  **workspace access** toggle (user decision, Validation Session 1). Enabled, the
  console runs on the workspace-bound pair; the toggle is component state, resets
  on panel unmount and on vault lock, and is never persisted. The panel states the
  current mode next to the console.
- When sandbox settings change, the manager rebuilds its runner pairs, disposing
  the previous ones, and the Phase 1 runner source reflects the new pair on the
  next call. Unrelated settings writes (for example a provider edit) must not
  rebuild anything: the session subscribes to `settings.sandbox` only
  (findings 9).
- `sandbox.enabled` is bound to the Phase 1 runner source's `isEnabled()`, so
  `isAvailable` returns false for `run_js`/`run_python` and the tools leave
  `availableNames` without registry mutation (findings 1, 15).

Non-functional:

- Timeout validation rejects `NaN`, `Infinity`, `0`, negatives, and fractions.
- The manager is a pure factory over settings; it holds no global state beyond the
  memoized runner pair and the last-run record.
- Rebuilding runners disposes the previous ones through the new public
  `dispose()` on both runners, so no warm Pyodide worker is orphaned; the manager
  also exposes a `dispose()` for session teardown.
- The manager is a pure factory over settings; it holds no global state beyond the
  memoized runner pairs and the last-run record.
- No new dependency is added.
- Errors from a run render as text; nothing is interpreted as HTML.

## Architecture

```
src/vault/settings.ts     + sandbox slice (enabled, jsTimeoutMs, pyTimeoutMs)
src/sandbox/manager.ts    runner owner: tool pair (workspace-bound) + console
                          pair (file-less), availability, last run, dispose
src/sandbox/manager.test.ts  injected worker factory tests
src/sandbox/js-runner.ts  + dispose()
src/sandbox/py-runner.ts  + dispose()
src/ui/panels/sandbox.tsx enable/timeouts/status/scratchpad
src/session/session.ts    bind the Phase 1 runner source to the manager;
                          subscribe to settings.sandbox
src/ui/shell.tsx          mounts the panel
```

Manager contract:

```ts
export interface RunnerAvailability {
  js: boolean
  python: boolean
  reason?: string
}

export interface SandboxManager {
  /** Stable holder: the object identity never changes; its fields do. */
  toolRunners(): { js: CodeRunner; python: CodeRunner }
  consoleRunners(): { js: CodeRunner; python: CodeRunner }
  availability(): RunnerAvailability
  lastRun(): { language: 'js' | 'python'; result?: RunResult; error?: string } | null
  run(language: 'js' | 'python', source: string, options?: { workspace?: boolean }): Promise<RunResult>
  setSettings(sandbox: SandboxSettings): void
  dispose(): void
}

export function createSandboxManager(options: {
  settings: SandboxSettings
  workspace?: WorkspaceApi
  workerFactory?: { js?: WorkerFactory; python?: WorkerFactory }
}): SandboxManager
```

`toolRunners()` returns the workspace-bound pair; `consoleRunners()` returns the
file-less pair. The Phase 1 runner source is bound to
`{ getRunners: () => manager.toolRunners(), isEnabled: () => settings.sandbox.enabled }`,
so the already-registered code provider sees enablement changes and runner swaps
without re-registration (findings 1, 9, 14).

`run` selects the runner pair from `options.workspace`: default is the file-less
`consoleRunners()`, and `{ workspace: true }` uses the workspace-bound
`toolRunners()`. It records the outcome in `lastRun` and rethrows nothing: it
resolves with a `RunResult` whose `error` is set for a runner failure, or records
a thrown `SandboxTimeoutError` as `{ error }` so the panel always has something to
render.

Settings defaults decision: `src/sandbox/js-runner.ts:9` and
`src/sandbox/py-runner.ts:9` own the timeout constants. To keep
`src/vault/settings.ts` free of app-local imports (the same rule Phase 5 follows
for its skill ref), `settings.ts` defines `DEFAULT_SANDBOX_JS_TIMEOUT_MS = 10_000`
and `DEFAULT_SANDBOX_PY_TIMEOUT_MS = 30_000` locally, and a unit test asserts they
equal `DEFAULT_JS_TIMEOUT_MS` and `DEFAULT_PY_TIMEOUT_MS`.

Scratchpad workspace decision: the console **defaults** to the file-less runner
pair and can opt into the workspace-bound pair per session (user decision,
Validation Session 1). Passing a `WorkspaceApi` into the console by default would
widen the sandbox's reach to the user's folder from a free-form console with no
tool-call framing, on top of the residual egress risk already accepted by the
engine plan, so it is opt-in. The model-facing `run_js`/`run_python` tools always
use the workspace-bound pair, which is a **separate** pair; a single shared pair
cannot be both (red-team finding 14). This is recorded in the panel and the
journal, and the manager test asserts the console default pair's `workspace` is
undefined while `{ workspace: true }` uses the bound pair.

## Files to Create / Modify

- Create: `src/sandbox/manager.ts`
- Create: `src/sandbox/manager.test.ts`
- Create: `src/ui/panels/sandbox.tsx`
- Modify: `src/sandbox/js-runner.ts` (`dispose()`)
- Modify: `src/sandbox/js-runner.test.ts` (dispose terminates the worker)
- Modify: `src/sandbox/py-runner.ts` (`dispose()`)
- Modify: `src/sandbox/py-runner.test.ts` (dispose terminates the warm worker)
- Modify: `src/vault/settings.ts` (additive `sandbox` slice + defaults)
- Modify: `src/vault/settings.test.ts` (defaults + deep-merge tolerance)
- Modify: `src/vault/test-fixtures.ts` (`FIXTURE_SETTINGS` gains `sandbox`)
- Modify: `src/vault/store.test.ts` (the exact-equality assertion still matches)
- Modify: `src/session/session.ts` (bind the runner source to the manager;
  subscribe to `settings.sandbox`)
- Modify: `src/ui/shell.tsx` (mount the panel)

## Implementation Steps

1. Add the `SandboxSettings` type and the `sandbox` field to `Settings` in
   `src/vault/settings.ts`, with `DEFAULT_SANDBOX_JS_TIMEOUT_MS` and
   `DEFAULT_SANDBOX_PY_TIMEOUT_MS`. Add `sandbox: { enabled: true, jsTimeoutMs:
   DEFAULT_SANDBOX_JS_TIMEOUT_MS, pyTimeoutMs: DEFAULT_SANDBOX_PY_TIMEOUT_MS }` to
   `defaultSettings()`. `deepMerge` fills it for existing vaults on the next
   unlock. Update `FIXTURE_SETTINGS` (`src/vault/test-fixtures.ts:37`) so the
   required `Settings` shape still typechecks and
   `src/vault/store.test.ts:221`'s exact-equality assertion still holds.
2. Add a public `dispose(): void` to `JsRunner` (`src/sandbox/js-runner.ts`) and
   `PyRunner` (`src/sandbox/py-runner.ts`) that terminates the worker and closes
   the port. `PyRunner.terminateAndRespawn` is private
   (`src/sandbox/py-runner.ts:126`); `dispose()` must not respawn. Extend both
   runner test files to assert the worker is terminated.
3. Add `src/sandbox/manager.ts` with `createSandboxManager`. Own two runner pairs:
   a **tool pair** built with `{ workspace, workerFactory: jsFactory,
   defaultTimeoutMs }` and a **console pair** built with the same options minus
   `workspace`. Rebuild both when `setSettings` receives different values,
   disposing the previous pairs first. `availability()` returns
   `{ js: typeof Worker !== 'undefined', python: typeof Worker !== 'undefined' }`
   with a reason string when false. `dispose()` tears down both pairs.
4. Write `src/sandbox/manager.test.ts` with fake worker factories in the style of
   `src/sandbox/js-runner.test.ts`: a run resolves a `RunResult` and records
   `lastRun`; a timeout rejection is recorded as an error rather than thrown; a
   settings change rebuilds the pairs and the previous workers are terminated
   (assert via the fake factory's terminate spy); the console default pair's
   `workspace` is `undefined`, the tool pair's is the injected `WorkspaceApi`, and
   `run(..., { workspace: true })` uses the bound pair; `availability` flips with a
   stubbed global; `run` records an error when `enabled` is false.
5. Extend `src/vault/settings.test.ts`: `defaultSettings().sandbox` equals the
   runner constants; `deepMerge` fills a missing `sandbox` slice; an old settings
   object with no `sandbox` key migrates without error and without a version bump.
6. Add `src/ui/panels/sandbox.tsx`: an enable toggle persisted with
   `useVaultStore.update({ sandbox: { enabled } })`; numeric `Row`s for the two
   timeouts persisted on blur with validation; an availability status line; and the
   console (language `<select>`, `font-mono` textarea, Run button,
   `disabled` when `!sandbox.enabled || running`). Render `stdout`, `stderr`,
   `result`, and `error` in labelled, `wrap-break-word` blocks; use
   `truncateOutput`'s 64 KB ceiling as the documented display bound. Add a
   per-session "Workspace access" checkbox next to the console (component state,
   reset on unmount and on vault lock, never persisted) that passes
   `{ workspace: true }` to `run`, and a status line stating which mode the next
   run uses.
7. Modify `src/session/session.ts` to own the `SandboxManager`, bind the Phase 1
   runner source to `{ getRunners: () => manager.toolRunners(), isEnabled: () =>
   sandbox.enabled }`, and subscribe to `settings.sandbox` only so an unrelated
   settings write does not rebuild runners. Keep the `run_js` / `run_python` tools
   returning `RunResult` unchanged, and assert in a test that
   `availableNames()` loses both names when `enabled` is false.
8. Mount `Sandbox` in the shell rail in `src/ui/shell.tsx`, and add this plan to
   `plans/README.md` (index row plus a one-line status note).
9. `pnpm test`, `pnpm lint`, `pnpm build`.
10. Browser gate: toggle enablement off and confirm Run is disabled and the model
    tool list no longer offers `run_js`/`run_python`; set a small JS timeout and
    run an infinite loop, confirming a timeout error; run a JS snippet and see
    `stdout`/`result`; run a Python snippet and see output; toggle workspace access
    on and confirm the console can read a file, then toggle it off and confirm the
    mode resets after a reload; reload and confirm the sandbox settings persisted
    while the access toggle did not. Record in the journal.

## Todo

- [ ] additive `Settings.sandbox` slice with runner-matching defaults
- [ ] `src/sandbox/js-runner.ts` / `py-runner.ts` `dispose()` + tests
- [ ] `src/sandbox/manager.ts` (tool pair + console pair, availability, last run, dispose)
- [ ] `src/sandbox/manager.test.ts` with injected worker factories (console pair file-less)
- [ ] settings defaults/merge test + `FIXTURE_SETTINGS` and `store.test.ts` updated
- [ ] `src/ui/panels/sandbox.tsx` (toggle, timeouts, status, scratchpad,
      per-session workspace-access checkbox)
- [ ] session binds the runner source; `settings.sandbox`-only subscription
- [ ] disable removes `run_js`/`run_python` from `availableNames`
- [ ] `plans/README.md` indexes this plan
- [ ] shell mounts the panel
- [ ] browser gate recorded
- [ ] lint / build / full test green

## Verification

- `pnpm test -- src/sandbox src/vault` passes, including the manager tests with
  fake workers and the settings defaults test.
- `pnpm test` full suite green (assert; do not encode a count).
- `pnpm lint` and `pnpm build` clean.
- Browser gate recorded in the journal: disabled state, JS timeout kill, JS run,
  Python run, and settings persistence across reload.
- Server-render smoke: if the console's static empty/error output blocks are
  hook-free, assert with `renderToStaticMarkup` that a `RunResult` renders all
  four fields and that no secret material appears; otherwise state the console as
  browser-verified only.

## Success Criteria

- [ ] Acceptance criterion 10: availability, persisted enablement, persisted
      default timeouts, and a scratchpad that runs JS/Python and shows
      stdout/result/errors.
- [ ] A timeout terminates the run and surfaces an error instead of hanging.
- [ ] Timeouts and enablement survive reload.
- [ ] The console defaults to the file-less pair; workspace access is a
      per-session opt-in that resets on unmount/lock and is not persisted, while
      the model tool pair always keeps the bridge.
- [ ] `sandbox.enabled` removes `run_js`/`run_python` from `availableNames`.
- [ ] No new dependency: the panel uses the same `CodeRunner` implementations and
      a second instance of them, not a second execution path.
- [ ] `plans/README.md` indexes this plan.

## Risk Assessment

| Risk | Signal it broke | Pre-decided response |
|------|-----------------|----------------------|
| `Worker` is unavailable in the browser | Run throws immediately | `availability()` reports it; disable Run with the reason; do not attempt a run. |
| Python is slow to warm and appears hung | Run looks stuck for tens of seconds | `PyRunner` keeps a warm worker (Phase 5 of the predecessor) and serializes runs; show a running state and the configured timeout. |
| A settings change swaps runners mid-run | A run resolves against a terminated worker | Only swap between runs; the panel disables Run while running and the manager rebuilds lazily on the next `toolRunners()`/`consoleRunners()` call. |
| The old `PyRunner` worker is not disposed on rebuild | Orphaned worker per settings change | New public `dispose()` terminates the worker; the manager disposes both previous pairs on rebuild; the session subscribes to `settings.sandbox` only. |
| Timeout input accepts `NaN` or `Infinity` | Runner timer fires instantly or never | Validate positive finite integers client-side and clamp to a documented upper bound. |
| Scratchpad gains workspace access without an explicit opt-in | Console can read the folder by default | Default mode is the file-less pair; `{ workspace: true }` is only sent when the per-session checkbox is on; the manager test asserts the default pair's `workspace` is undefined. |
| The access toggle survives the session | A later console run reads the folder unintentionally | Component state reset on unmount and on vault lock; never written to settings; browser gate checks reset after reload. |
| The sandbox `enabled` flag is ignored by model tools | Disabling has no effect on `run_js` | Bind the Phase 1 runner source's `isEnabled()` to `sandbox.enabled`, so `isAvailable` returns false and the names leave `availableNames` (red-team findings 1, 15); assert it in a session test. |
| A required `Settings.sandbox` breaks other consumers | `pnpm build`/`pnpm test` fails | Update `src/vault/test-fixtures.ts` and `src/vault/store.test.ts` in this phase (red-team finding 4). |

## Security Considerations

- The scratchpad runs file-less by default; the workspace bridge is an explicit
  per-session opt-in that resets on unmount and on vault lock and is never
  persisted. The model-facing tools always keep their bridge, and the residual
  egress risk is the one already accepted by the engine plan.
- The vault key never enters a worker, and the panel never passes settings,
  provider configuration, or secrets into a run.
- Executed code output is rendered as text, truncated at the existing 64 KB
  ceiling, and never injected as markup.
- Disabling the sandbox removes `run_js`/`run_python` from the available tool set,
  so a user can turn off model-initiated execution, not just the console.
- No new network path is added by the panel.

## Next Steps

This is the final phase; on completion the plan's Success Criteria and the
journal artifact are the completion record.
