---
phase: 5
title: "Code Runners"
status: done
priority: P1
effort: "12h"
dependencies: [4]
---

# Phase 5: Code Runners

## Goal

Run user/model-authored JavaScript and Python in isolated workers with captured
output, force-termination on timeout that rejects every pending file RPC, and file
access only through a main-thread RPC bridge — using an injectable worker factory
so lifecycle is unit-testable in node.

## Context

- Phase 1's spike already confirmed eval/WASM/terminate under the strict document
  CSP and recorded the worker's fetch/IndexedDB reach. If it failed, this phase is
  blocked pending a re-plan.
- `CodeRunner`/`RunOptions`/`RunResult` are frozen in `src/sandbox/types.ts`.
- The workspace bridge target is Phase 4's `WorkspaceFs`.
- `tsconfig.app.json:5` has no `webworker` lib; worker files need
  `/// <reference lib="webworker" />`.
- `pyodide@314.0.7` is self-hosted; `Worker.terminate()` is the only timeout
  because `SharedArrayBuffer` is unavailable (`researcher-01:188-197`).

## Requirements

Functional:

- `JsRunner` implements `CodeRunner`: one fresh worker per run, terminated after
  completion or timeout.
- `PyRunner` implements `CodeRunner`: a persistent module worker that loads
  Pyodide lazily on first run, communicates over a captured `MessagePort` (never a
  global handler), and is terminated and respawned on timeout or fatal error.
- `RunResult = { stdout, stderr, result, error? }`; stdout/stderr capped at 64 KiB
  each.
- Executed code gets an async `fs` API (`readFile`, `writeFile`, `list`) that
  routes through main-thread `WorkspaceFs`; Python imports it as a `workspace`
  module.
- On terminate, every pending `fs` RPC rejects with `SandboxTimeoutError`, the
  pending map is cleared, and listeners are removed.
- `run_js` and `run_python` tools built with `jsonSchema`.
- All inbound worker messages are validated against the discriminated union and
  matched to the in-flight `runId`; anything else is dropped.

Non-functional:

- `assertSerializable` is allow-list based: strings, finite numbers, booleans,
  null, plain objects, arrays, `Uint8Array`; everything else (class instances,
  `Map`, `Set`, `Blob`, `Error`, `CryptoKey`, `FileSystemHandle`,
  `SharedArrayBuffer`, functions, symbols) is rejected with
  `BridgeSerializationError` after recursion.
- Runners accept an injected `WorkerFactory` so tests drive a fake worker.
- No main-thread eval.

## Architecture

```
src/sandbox/types.ts       RunOptions, RunResult, CodeRunner (from Phase 1)
src/sandbox/protocol.ts    bridge union, assertSerializable, parseInbound
src/sandbox/worker-factory.ts  WorkerFactory port + default implementation
src/sandbox/js-worker.ts   worker entry: run JS, capture console
src/sandbox/js-runner.ts   per-run worker, timeout, fs RPC server
src/sandbox/py-worker.ts   module worker: lazy Pyodide, captured port, js module
src/sandbox/py-runner.ts   persistent worker, terminate/respawn
src/tools/builtin/code.ts  run_js, run_python provider
scripts/copy-pyodide.mjs   copy npm pyodide assets into public/pyodide/
```

Bridge:

```ts
type ToWorker =
  | { kind: 'run'; runId: string; language: 'js' | 'py'; source: string }
  | { kind: 'fs.result'; requestId: string; ok: true; data: string }
  | { kind: 'fs.error'; requestId: string; ok: false; message: string }

type FromWorker =
  | { kind: 'result'; runId: string; stdout: string; stderr: string; result: string | null; error?: string }
  | { kind: 'fs.call'; runId: string; requestId: string; op: 'read' | 'write' | 'list'; path: string; data?: string }
```

`parseInbound(raw)` validates the shape before the runner dispatches; unknown
shapes and mismatched `runId` are ignored.

## Files to Create / Modify

- Create: `src/sandbox/protocol.ts`
- Create: `src/sandbox/protocol.test.ts`
- Create: `src/sandbox/worker-factory.ts`
- Create: `src/sandbox/js-worker.ts`
- Create: `src/sandbox/js-runner.ts`
- Create: `src/sandbox/js-runner.test.ts`
- Create: `src/sandbox/py-worker.ts`
- Create: `src/sandbox/py-runner.ts`
- Create: `src/sandbox/py-runner.test.ts`
- Create: `src/tools/builtin/code.ts`
- Create: `src/tools/builtin/code.test.ts`
- Create: `scripts/copy-pyodide.mjs`
- Modify: `package.json` (add `pyodide@314.0.7`; `predev`/`prebuild` scripts)
- Modify: `.gitignore` (`public/pyodide/`)
- Modify: `vite.config.ts` (add `worker-src 'self'`; update the CSP comment)

## Implementation Steps

1. Add `src/sandbox/protocol.ts`: unions, allow-list `assertSerializable`, and
   `parseInbound`.
2. Add `src/sandbox/worker-factory.ts` with `WorkerFactory = (url: URL, options) =>
   Worker` and a default using `new Worker(new URL(...), { type: 'module' })`.
3. Add `src/sandbox/js-worker.ts` (`/// <reference lib="webworker" />`): on `run`,
   build an async function from the source with injected `console` and `fs`,
   `await` it, stringify the result, post `{ kind: 'result' }`; catch and return
   `error` with partial output.
4. Add `src/sandbox/js-runner.ts`: create one worker via the factory per run,
   answer `fs.call` through `WorkspaceFs`, reject all pending RPC on timeout,
   terminate, remove listeners, and dispose (a `disposed` flag makes `safePost` a
   no-op). Cap output.
5. Add `scripts/copy-pyodide.mjs` and `predev`/`prebuild` scripts; add
   `public/pyodide/` to `.gitignore`; install `pyodide@314.0.7`.
6. Add `src/sandbox/py-worker.ts`: `import(/* @vite-ignore */ '/pyodide/pyodide.mjs')`,
   `loadPyodide({ indexURL: '/pyodide/' })`, create a `MessageChannel` whose port
   is captured in a closure (not `self.onmessage`) for runs and `fs` RPC, register
   a `workspace` JS module, capture stdout/stderr, run `pyodide.runPythonAsync`.
7. Add `src/sandbox/py-runner.ts`: lazy init, reuse the worker, validate inbound
   messages, terminate + respawn on timeout or fatal error, reject pending RPC.
8. Add `src/tools/builtin/code.ts` with `run_js`/`run_python` built from
   `CodeRunner` ports; register as a `ToolProvider`.
9. Modify `vite.config.ts`: add `worker-src 'self'` and update the comment to state
   that a self-origin worker does not inherit the meta CSP, so the document stays
   `script-src 'self'` and no `unsafe-eval` is needed. The comment also records the
   accepted residual worker-egress risk.
10. Tests:
    - `protocol.test.ts`: allow-list accepts/rejects each type; `parseInbound`
      rejects unknown and mismatched `runId`.
    - `js-runner.test.ts`/`py-runner.test.ts` with a fake `Worker`: terminate on
      timeout; every pending `fs.call` rejects; listeners removed; `safePost`
      no-ops after dispose; output caps.
    - `code.test.ts`: tool wiring with a fake runner; output passing; error
      propagation.
11. `pnpm test`, `pnpm lint`, `pnpm build`.

## Todo

- [x] `src/sandbox/protocol.ts` + allow-list tests
- [x] `src/sandbox/worker-factory.ts`
- [x] `src/sandbox/js-worker.ts` + `js-runner.ts` + fake-worker tests
- [x] Pyodide assets script + gitignore + `pyodide@314.0.7`
- [x] `src/sandbox/py-worker.ts` + `py-runner.ts` + fake-worker tests
- [x] `src/tools/builtin/code.ts` + tests
- [x] `vite.config.ts` `worker-src 'self'` + comment
- [x] lint / build / full test green

## Verification

- `pnpm test -- src/sandbox src/tools` passes, including terminate/timeout/RPC-leak.
- Journal (browser): `run_js` prints and returns; an infinite loop terminates with
  `SandboxTimeoutError`; `run_python` prints and returns; Python reads and writes a
  workspace file; a second `run_python` after a timeout still works.
- Serializer test: posting a `CryptoKey` or a handle throws
  `BridgeSerializationError`.
- `pnpm build` emits worker chunks; the built CSP contains `worker-src 'self'` and
  no `'unsafe-eval'` on `script-src`.

## Success Criteria

- JS and Python run in workers and return structured output.
- A timeout kills the worker, rejects all pending RPC, and leaks nothing.
- Executed code reaches the workspace only through validated RPC.
- The vault key cannot cross the bridge; the handle is never in the worker's reach.
- Runner lifecycle is covered by unit tests via the fake worker factory.

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Worker CSP behavior differs from Phase 1's spike | Spike is authoritative; if it passed, this phase proceeds. |
| Pyodide terminate forces a reload | Warm worker unless a timeout/fatal error; document; the next run reloads lazily. |
| Untrusted code hijacks the run channel | Python uses a captured `MessagePort`; JS uses a fresh worker; inbound messages are validated and `runId`-matched. |
| Output blow-up | 64 KiB caps per stream. |
| Worker-global typings fail `tsc -b` | `/// <reference lib="webworker" />` in worker files. |

## Security Considerations

- Allow-list serializer is the single bridge enforcement point and is unit-tested.
- No key and no handle cross the bridge; paths are re-validated by `WorkspaceFs`.
- Accepted residual risk: worker code has page-equivalent network reach, recorded
  in `plan.md`; no secrets are reachable.
- Optional deployment hardening: a worker-asset response-header CSP with
  `connect-src 'self'`; host-dependent and not a gate.

## Next Steps

Phase 6 wires the runners into the engine as `run_js`/`run_python` tools.
