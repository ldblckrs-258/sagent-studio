# Implemented: Core Chat Engine

Manual-validation artifact for the [Core Chat Engine plan](../260919-0828-core-chat-engine/plan.md).
Browser-only checks are recorded here with date, build hash, browser version,
command, and observed result. Phase completion is contingent on the relevant
entries.

## 2026-09-19 — Phase 1: worker runtime spike

**Purpose.** Confirm the plan's stop-the-line assumption: a Vite-bundled
same-origin worker runs `eval` and WASM under the strict document CSP without
inheriting it, `Worker.terminate()` stops a running worker, and the worker has
real network and IndexedDB reach.

**Build.** Commit `a3959f18b944830726c249deb16853c00dde875c` (`a3959f1`), spike
worker chunk `dist/assets/worker-Bs-eEv7m.js`.

**Browser.** HeadlessChrome/147.0.0.0 (agent-browser 0.25.4), macOS
`Macintosh; Intel Mac OS X 10_15_7`, origin `http://localhost:4178`.

**Commands.**
- `vite build --config vite.spike.config.ts` (temp config, worker `format: 'es'`)
- `vite preview --config vite.spike.config.ts --port 4178 --strictPort` →
  `http://localhost:4178/spike.html`
- `vite --config vite.spike.config.ts --port 5178 --strictPort` →
  `http://localhost:5178/spike.html`
- Driven with `agent-browser open … ; agent-browser wait 4000 ;
  agent-browser eval "JSON.stringify(window.__spike)"`

**Observed — built + previewed (document CSP meta present).**

Document CSP:
`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; base-uri 'none'; form-action 'self'; object-src 'none'` — no `worker-src`, no `'unsafe-eval'`.

- `new Function('return 1+1')()` → `{ ok: true, value: 2 }`.
- `WebAssembly.compile(8-byte module)` → `{ ok: true, ok2: true }`.
- Worker `fetch('https://example.com/', { mode: 'no-cors' })` →
  `{ ok: true, status: 0, type: 'opaque' }`; worker `fetch('https://api.github.com/zen')`
  → `{ ok: true, status: 200, body: 'Encourage flow.' }`. Egress is not blocked.
- `indexedDB.open('sagent-vault')` → `{ ok: true, version: 1, stores: [] }`.
- Worker URL resolved to `/assets/worker-Bs-eEv7m.js` (same-origin);
  `crossOriginIsolated: false`.
- `worker.terminate()` returned in `0 ms`; the main thread stayed responsive; a
  fresh control worker answered `ping` (`controlWorkerPongs: true`); the
  terminated worker did not (`killedWorkerPongs: false`). Note the killed worker
  was inside a synchronous infinite loop, so it could not have answered even if
  alive; the decisive evidence is the main thread surviving and the pair of
  control/killed results.

**Observed — `pnpm dev` (no CSP meta; the CSP plugin is build-only).**

`cspMeta: null`. `eval`, WASM, IndexedDB, and terminate all behave as above. Dev
is not a CSP test; it only confirms the modules run under Vite's dev transform.

**Interpretation.** The strict document CSP is not inherited by the
Vite-emitted same-origin worker chunk, whose policy comes from its own (absent)
response headers. `script-src 'self'` stays and no `'unsafe-eval'` is needed.
The worker has page-equivalent network egress and can open `sagent-vault`, which
matches the accepted residual risk in the plan's Key Decisions.

**Note.** `vite preview` is a static file server, not a production host. It
serves no CSP response headers for the worker asset, so this spike proves the
mechanism, not a production deployment's headers. Optional host-level hardening
(`connect-src 'self'` on the worker response) remains host-dependent.

**Cleanup.** `spike/`, `spike.html`, and `vite.spike.config.ts` were deleted
after this record was written.

## Pending manual checks

- Phase 4: pick a folder, list, write, read back, reload, re-grant, read back;
  confirm `../` and backslash paths are rejected; non-Chromium degradation.
- Phase 5: `run_js` print/return and timeout kill; `run_python` print/return;
  Python workspace read/write; a second `run_python` after a timeout.
- Phase 6: real-provider turn, edit, rerun, undo, and persistence across reload.

## 2026-09-19 — Phase 5: sandbox runners in a real browser

**Purpose.** Execute the real worker entries (`js-worker`, `py-worker`) under the
built CSP and confirm the bridge, timeout, terminate, and Pyodide paths.

**Build.** Commit `a3959f18b944830726c249deb16853c00dde875c`, built with a temporary
`vite.spike.config.ts` that adds `spike-runners.html` so the runners are in the
module graph. Worker chunks emitted: `dist/assets/js-worker-DoiRr4_L.js` and
`dist/assets/py-worker-38fnEfdX.js`. `scripts/copy-pyodide.mjs` copied 5 Pyodide
files to `public/pyodide/`.

**Browser.** HeadlessChrome/147.0.0.0 (agent-browser 0.25.4), origin
`http://localhost:4180` (`vite preview` of the spike build).

**Observed (built + previewed, document CSP present).**

| Check | Result |
|-------|--------|
| `run_js` print + return | `{ stdout: "hello", stderr: "", result: "2" }` |
| `run_js` infinite loop | `SandboxTimeoutError: The sandbox run exceeded its time limit.` |
| JS workspace bridge write + read back | `"from-js"` |
| JS bridge traversal `../escape` | rejected: `The workspace path "../escape" is not allowed.` |
| `run_python` print + return | `{ stdout: "py-hello", stderr: "", result: "2" }` |
| Python workspace read/write via RPC bridge | stdout `"seeded"`, result `"py-done"`, file written `"from-py"` |
| Python infinite loop then a second run | timeout `SandboxTimeoutError`; second run printed `"after-timeout"` (worker respawned and reloaded) |

**Interpretation.** Real worker entries run under the built CSP with no
`'unsafe-eval'`; the allow-list bridge rejects a traversal path; timeout kills the
worker and rejects pending RPCs; Pyodide loads lazily, is force-terminated on
timeout, and a later run succeeds on a respawned worker.

**Build note.** `pnpm build` on the app alone does not emit the worker chunks
because no app entry imports the runners yet; the chunks appear only once the
runners are in the module graph (demonstrated with the spike entry). The UI
ticket's composition root will make them part of the normal build.

**Cleanup.** `spike/`, `spike-runners.html`, and `vite.spike.config.ts` were
deleted after this record.

## Review dispositions (2026-09-19)

An independent code review found one high-severity defect and three medium items;
all were fixed and covered by new tests:

- **Pre-stream failure left an orphaned placeholder assistant message** that a
  later turn would persist. Fixed in `src/chat/engine.ts`: a `buildRunStream`
  failure now restores `baseMessages` and persists before rethrowing. Regression
  test: "drops the assistant placeholder when the stream fails to build".
- **`PyRunner` was unsafe for concurrent runs** (parallel tool calls would
  cross-attribute stdout and `fs` RPCs). Runs are now serialized on an internal
  queue; test "serializes concurrent runs on the shared worker".
- **`providerOptions` was validated but never forwarded.** It now reaches
  `streamText`; test asserts the request carries it.
- **One malformed workspace `SKILL.md` aborted the whole listing.** Parse
  failures are now skipped per skill; test added.
- Minor: `ToolRegistry.hydrate` added for tool reload parity, stricter persisted
  http-definition validation, dead test code removed, bridge/handle rejection
  branch strengthened.

## Manual checks not performed

- **Phase 4 folder picker + reload re-grant.** `showDirectoryPicker` requires a
  real user gesture and a native OS directory dialog, which headless CDP cannot
  drive. The path-validation, permission-mapping, and read/write/remove logic is
  covered by `fake-handle` unit tests; the picker/re-grant step needs a manual
  Chromium session.
- **Phase 6 real-provider turn.** No live provider API key is available in this
  environment, so edit/rerun/undo/persistence over a real provider was not run.
  Every engine path is covered with `MockLanguageModelV4`.

