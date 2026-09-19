# Sandbox persistence research: warm worker reuse, Python state, interrupt model, workspace search, binary reads

- **Plan:** `260919-1821-harness-tools`
- **Date:** 2026-09-20
- **Scope:** Exact, current facts needed to design (a) a persistent sandbox session (warm module worker / warm Pyodide, reset + idle reap), (b) an efficient workspace `search`/grep tool, and (c) binary/image reads.
- **Already implemented in repo (context, not researched further):** `src/sandbox/js-runner.ts` (fresh worker per run, terminate on settle), `src/sandbox/py-runner.ts` (already retains one warm worker + `MessageChannel`, serialized queue, respawn on fatal/timeout), `src/sandbox/py-worker.ts` (module-scope Pyodide + module-scope run state), `src/sandbox/fs-bridge.ts`, `src/workspace/fs.ts`, `src/sandbox/protocol.ts`.

## Outcome (recommendation, ranked)

The repo is already ~80% of the way to a persistent session in the Py path (`PyRunner` keeps a warm worker; `JsRunner` does not). The correct design is to promote the `PyRunner` shape into a single `SandboxSession` and give it a bounded, observable lifecycle.

1. **Warm worker with serialized runs + application-level idle reap + explicit reset.** One long-lived module worker per language, one run at a time (already enforced for Python; adopt for JS), reset by `Worker.terminate()` + respawn, and an idle timer whose deadline is reset on every message. This is the only design that is fully supported by normative behavior today: `postMessage` is a queue, `Worker.terminate()` is the only hard stop, and there is no spec-defined idle timeout to lean on.
2. **Do not attempt `pyodide.setInterruptBuffer()` for timeouts.** It is present in `pyodide@314.0.7`'s public typings and docs, but it hard-requires a `SharedArrayBuffer`, which requires cross-origin isolation (`COOP`/`COEP` **response headers**). This app has no such headers and a meta-tag CSP cannot set them. Cooperative interrupt is therefore unavailable; `Worker.terminate()` remains the timeout mechanism.
3. **For `search`/grep, walk with `FileSystemDirectoryHandle.values()` and `for await`, but read file contents in parallel with a concurrency cap (`Promise.all` seen in Chrome's guidance; cap it yourself).** Do the regex/substring scan on the main thread (or a dedicated pure-JS worker) rather than pushing every file through the existing string-only fs bridge.
4. **Binary reads need a protocol extension.** The current fs bridge carries `string` only and `assertSerializable` deliberately rejects `Blob` and non-`Uint8Array` views. Use `handle.getFile()` → `File` → `arrayBuffer()` and extend the bridge with an explicit `Uint8Array`/transferable path.

Adoption risk is low for items 1, 3, 4 (baseline APIs, all shipped). Item 2 is a hard capability limit, not a choice: assuming `setInterruptBuffer` works without cross-origin isolation is a correctness bug waiting to happen.

## Environment snapshot (verified from the workspace)

| Fact | Value | Source |
|---|---|---|
| pyodide package version | `314.0.7` | `node_modules/pyodide/package.json` |
| Embedded Python | `3.14.2` | `node_modules/pyodide/pyodide-lock.json` `info.python` |
| ABI / arch / platform | `2026_0` / `wasm32` / `emscripten_5_0_3` | same lockfile `info` |
| Packages in lockfile | 357 (includes `numpy`, `pandas`, `micropip` 0.11.1) | lockfile `packages` |
| `pyodide.asm.wasm` on disk | 9,598,218 bytes (~9.15 MiB) | `ls -la public/pyodide` |
| `python_stdlib.zip` on disk | 2,545,637 bytes (~2.43 MiB) | `ls -la public/pyodide` |
| Vite worker format | `es` (module workers) | `vite.config.ts` |
| CSP delivery | `<meta http-equiv>` injected at build; **no COOP/COEP anywhere** | `vite.config.ts`, `index.html` |

Worker chunks are emitted by Vite as same-origin assets and, per the repo's own comment, "do not inherit this document policy; its policy comes from its own response headers (HTML §7.1.7)". No response headers are configured, so **`crossOriginIsolated` is false in this app**, which is the load-bearing constraint on interrupts.

---

## 1. Module Worker reuse: is one Worker safe across sequential runs?

**Yes.** A dedicated `Worker` is an `EventTarget` with a message queue; `Worker.postMessage()` enqueues a message and the worker's own event loop drains it. Reusing one worker for multiple sequential `postMessage` runs is the normal model and is exactly what the Pyodide project's own web-worker example does: `loadPyodide()` once at module scope, then a single `self.onmessage` handler that runs each incoming script. (Pyodide "Using Pyodide in a web worker": https://pyodide.org/en/stable/usage/webworker.html.)

**Real risks of long-lived workers (behavior, not opinion):**

- **Module-scope state persists and can leak across runs.** Anything assigned to the worker's global scope (or to module-level `let`/`const` bindings) survives between messages. The repo already depends on and must manage this: `py-worker.ts` keeps `pyodidePromise`, `currentRunId`, `pendingFs`, `stdoutChunks`, `stderrChunks` at module scope; `js-worker.ts` keeps `currentRunId`, `pendingFs`, and the output buffers. A leaked entry in `pendingFs` or a stale `currentRunId` is a functional bug, not just a memory issue.
- **User JS can pollute worker globals.** With the current `AsyncFunction` model, user code that does `globalThis.x = ...` or attaches to `self` persists into later runs in a reused worker. Fresh-worker-per-run currently gives accidental isolation; a warm worker must either reset globals explicitly or accept cross-run bleed.
- **Unhandled promise rejections are observable but not fatal.** `WorkerGlobalScope` fires `unhandledrejection` and `error` events; the parent `Worker` object fires `error`. These are events, not automatic worker death. A persistent worker must install handlers inside the worker, otherwise rejections from a previous run can go unreported while the worker keeps serving new runs.
- **Memory growth is real but not spec-documented.** V8/WASM heap growth from user allocations is retained by a live worker; only `Worker.terminate()` reliably reclaims it. MDN does not publish a numeric growth model, so this is best treated as an unbounded-lifetime risk to bound with an idle/lifetime policy rather than a guarantee.
- **`Worker.terminate()` "Immediately terminates the worker. This does not let worker finish its operations; it is halted at once."** There is no graceful-stop signal. Any cleanup (flushing partial output, closing streams) must happen before you decide to terminate.

**Idle-terminate pattern:** there is **no standardized idle-terminate API.** The `Worker` interface exposes only `postMessage` and `terminate` (invalidating MDN citations below), and there is no spec-governed keepalive or timeout. The pattern is necessarily application-level: keep a `setTimeout` rearmed on every activity; on expiry call `terminate()` and null the reference. Treat "standard idle-terminate pattern" as a convention, not a platform feature.

**Sources:** MDN `Worker` (https://developer.mozilla.org/en-US/docs/Web/API/Worker); MDN `Worker.terminate()` (https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate); MDN `WorkerGlobalScope` events `error`/`unhandledrejection`/`rejectionhandled` (https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope); HTML spec, dedicated workers (https://html.spec.whatwg.org/multipage/workers.html#dedicated-workers-and-the-worker-interface); Pyodide web worker guide (https://pyodide.org/en/stable/usage/webworker.html).

---

## 2. Pyodide persistence: state across runs, reset, micropip, footprint

**Persists by default.** `pyodide.runPython(code)` and `runPythonAsync(code)` accept an optional `globals`; when omitted they default to `pyodide.globals` (a `PyProxy`). The Pyodide FAQ states the same directly: the second argument may include a `globals` element "which is a namespace for code to read from and write to". So a single runtime called repeatedly keeps variables, imports, and `sys.modules` entries across calls. The repo's `py-worker.ts` already relies on this: it loads Pyodide once (`loadPyodideOnce`) and calls `runPythonAsync(source)` with no `globals`, so **state already persists across `run()` calls in a warm worker** — this is current behavior, not a future feature.

**Reset options, cheapest first (all verified as available mechanics):**

1. Per-session isolated namespace: create a fresh dict via `pyodide.globals.get("dict")()` (FAQ pattern) and pass it as `globals`. Dropping the reference isolates that session's names. This does **not** undo module-level side effects (imports populate `sys.modules`, C extensions stay loaded, files written to the Emscripten FS remain).
2. Full reset: `Worker.terminate()` + create a new worker and `loadPyodide()` again. This is the only way to guarantee clean interpreter state and reclaim WASM memory, at the cost of a re-load (see footprint below).
3. Selective cleanup inside Python (`globals` key deletion, `importlib.invalidate_caches()` after writing modules — a documented gotcha).

For an agent harness where a stale global from run N-1 can silently change run N, option 2 behind an explicit "reset session" action plus option 1 for normal isolation is the defensible design.

**`micropip` at runtime:** yes. `micropip.install()` installs pure-Python wheels from PyPI and Pyodide-built wasm32/emscripten wheels from the JsDelivr CDN or arbitrary URLs; it is an async Python function requiring `await`. `micropip` itself is in the bundled lockfile (0.11.1), so it can be loaded with `await pyodide.loadPackage("micropip")` without a network fetch of the loader. `pyodide.loadPackage()` is the lower-overhead JS equivalent but has **no PyPI dependency resolution**; the docs advise micropip for everything except loading micropip itself. Important constraints:

- `pyodide.loadPackagesFromImports()` only resolves packages present in the Pyodide distribution (lockfile), **not PyPI**.
- "In general, loading a package twice is not permitted" for `loadPackage()`.
- micropip validates wheel integrity against PyPI hashes; arbitrary-URL installs need CORS on the origin, and the docs warn that third-party CORS proxies defeat integrity checking.

**Cost / caching behavior (partially unverified):** there is no browser-side wheel cache directory equivalent to Node's `packageCacheDir` (that option is explicitly documented as Node-only). Wheel and package downloads are ordinary `fetch`es from the CDN/PyPI, so **browser HTTP cache is the effective cache**; the docs do not guarantee stronger caching. Each newly imported package is downloaded once and installed into the Emscripten site-packages for the lifetime of the runtime; a fresh worker re-downloads/re-installs (unless the HTTP cache serves it). PyPI installs also need network egress, which the strict CSP allows only because `connect-src` includes `https:`.

**Memory footprint of a warm instance:** **UNVERIFIED as a documentation number.** Pyodide's docs describe *download* size, not resident memory, and no authoritative warm-instance RAM figure is published for 314.0.7. The only concrete numbers available locally are artifact sizes (wasm ~9.15 MiB, stdlib zip ~2.43 MiB). Practical implication: the WASM linear memory dominates and grows with imported packages; `INITIAL_MEMORY` is a `loadPyodide` config option and `pyodide.makeMemorySnapshot()` exists, but neither yields a documented baseline. **Do not publish a RAM figure.** Treat warm Pyodide as "measurable, not documented" and instrument if a budget is required.

**Sources:** Pyodide FAQ (https://pyodide.org/en/stable/usage/faq.html); Pyodide "Loading packages" (https://pyodide.org/en/stable/usage/loading-packages.html); Pyodide JS API (https://pyodide.org/en/stable/usage/api/js-api.html); package typings `node_modules/pyodide/pyodide.d.ts` lines 1643-1644, 1706-1707 (`globals` default), 1520-1524 (`loadPackage`), 1630-1634 (`loadPackagesFromImports`), 1978-1985 (`packageCacheDir`, Node-only), 1562 (`globals: PyProxy`).

---

## 3. Timeout / kill model with a persistent worker

**Hard kill is only `Worker.terminate()`.** With no `SharedArrayBuffer`, there is no way to signal into a running worker. A blocked synchronous `runPython` cannot be preempted from outside; terminating the worker is the only stop. The repo's `PyRunner` already implements exactly this: timeout → mark entry settled → `terminateAndRespawn()`.

**What `pyodide@314.0.7` actually exposes (verified in package typings):**

- `static setInterruptBuffer(interrupt_buffer: TypedArray): void` — present in `PyodideAPI` (`node_modules/pyodide/pyodide.d.ts:1893`).
- `static checkInterrupt(): void` — present (`:1902`).
- Implementations exist in the shipped bundle (`pyodide.asm.mjs` contains both symbols; the outer `pyodide.mjs` facade does not, which is expected since the API is attached by the asm module).

**The blocking constraint:** the doc comment on `setInterruptBuffer` says it "is only useful when Pyodide is used in a webworker. The buffer should be a `SharedArrayBuffer` shared with the main browser thread (or another worker)" (`pyodide.d.ts:1875-1893`). The Pyodide "Interrupting execution" page repeats it: interrupts require a web worker **and** a `SharedArrayBuffer`, which "means that your server must set appropriate security headers." MDN is explicit that the `SharedArrayBuffer` constructor is hidden and `postMessage` throws for SAB unless the document is cross-origin isolated via `Cross-Origin-Opener-Policy` + `Cross-Origin-Embedder-Policy` **headers**.

**This repo cannot use it.** There are no COOP/COEP response headers and no place to add them (the app ships a build-time `<meta>` CSP; meta tags cannot set COOP/COEP). So cooperative `SIGINT` interrupt is **unavailable**, and the accepted pattern here is timeout → `terminate()` → respawn. This matches the repo's existing `PyRunner` and is the honest recommendation.

If cross-origin isolation were ever added (a hosting decision), the documented flow would be: main thread creates `new Uint8Array(new SharedArrayBuffer(1))`, sends it to the worker, worker calls `pyodide.setInterruptBuffer(buffer)`, main thread writes `2` (SIGINT) to interrupt, and Pyodide resets the byte to `0` when handled. Note the documented requirement to clear the buffer to `0` before each run in case a previous interrupt was left set. Even then, interrupts only reach Python bytecode and C code that calls `PyErr_CheckSignals()`; a tight native loop without such calls still cannot be interrupted, so a hard `terminate()` fallback remains necessary.

**Sources:** `node_modules/pyodide/pyodide.d.ts:1875-1902`; Pyodide "Interrupting execution" (https://pyodide.org/en/stable/usage/keyboard-interrupts.html); MDN `SharedArrayBuffer` §Security requirements (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer); MDN `Worker.terminate()` (https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate).

---

## 4. File System Access API: recursive walks + binary/image reads

**Recursive walk.** `FileSystemDirectoryHandle.values()` returns an async iterator of child handles; `for await...of` is the documented iteration form, and each handle's `kind` is `"file"` or `"directory"`. MDN's canonical recursive example is an async generator that yields `File` objects, recursing via `yield* getFilesRecursively(handle)` and calling `await entry.getFile()` per file. The API is Baseline widely available (since March 2023), secure-context only, and **available in Web Workers**. `values()` throws `NotAllowedError` if read permission is not `granted`, and `NotFoundError` if the entry vanished mid-walk. The spec hook is `#api-filesystemdirectoryhandle-asynciterable`.

**Performance guidance (authoritative, from Chrome's File System Access guide):** do **not** `await` each `getFile()` sequentially; collect the promises and resolve them together, e.g. `Promise.all()`. The guide's example pushes `entry.getFile().then(...)` into an array while iterating, then awaits the array. For very large trees, the practical refinement is to cap concurrency in batches rather than fire an unbounded `Promise.all`; Chrome states the parallel rule but publishes no numeric cap, so the cap is an engineering choice (mark any specific number UNVERIFIED). A headless `search` should also short-circuit on ignore globs before calling `getFile()`, since directory iteration itself is cheap but `getFile()` is the syscall-ish cost.

**Reading bytes / binary detection.** `FileSystemFileHandle.getFile()` resolves to a `File` (a `Blob` subclass, usable in any Blob context). The Chrome guide documents two gotchas: (1) read sequentially with `stream()`/`text()`/`arrayBuffer()` for the common case, use `slice()` for random access; (2) **the `File` object is only readable while the underlying on-disk file is unchanged — if it changes, you must call `getFile()` again.** For binary/data-URI work:

- `Blob.size` (read-only) returns the size in bytes; available in workers. Use it to reject huge files **before** materializing them.
- `Blob.arrayBuffer()` returns a `Promise<ArrayBuffer>`; returns a promise rather than the event-based `FileReader.readAsArrayBuffer()`.
- `Blob.type` returns the MIME type, but MDN warns it is **extension-derived, not content-derived**: a renamed PNG reports `text/plain`, uncommon extensions return `""`, and it must not be the sole detection scheme. Real binary/text detection should sniff magic bytes from the `ArrayBuffer` instead of trusting `type`.

**Size limits.** There is **no API-level or spec-level size limit** on `getFile()`/`arrayBuffer()`; limits are memory-bound (the whole blob is materialized). This repo already imposes its own `DEFAULT_SIZE_CAP = 2 * 1024 * 1024` bytes in `src/workspace/fs.ts` and enforces it on read/write. Recommendation: gate binary reads on `File.size` against the same cap (or a separate, larger image cap) before calling `arrayBuffer()`.

**Sources:** MDN `FileSystemDirectoryHandle` and `values()` (https://developer.mozilla.org/en-US/docs/Web/API/FileSystemDirectoryHandle, https://developer.mozilla.org/en-US/docs/Web/API/FileSystemDirectoryHandle/values); WHATWG File System spec (https://fs.spec.whatwg.org/#api-filesystemdirectoryhandle-asynciterable); Chrome "The File System Access API" (https://developer.chrome.com/docs/capabilities/web-apis/file-system-access); MDN `Blob.size` (https://developer.mozilla.org/en-US/docs/Web/API/Blob/size); MDN `Blob.type` (https://developer.mozilla.org/en-US/docs/Web/API/Blob/type); MDN `Blob.arrayBuffer()` (https://developer.mozilla.org/en-US/docs/Web/API/Blob/arrayBuffer); MDN `File` (https://developer.mozilla.org/en-US/docs/Web/API/File).

---

## 5. Web Worker binary transfer: structured clone vs transferables

- **Structured clone copies.** `postMessage` uses the structured clone algorithm; `ArrayBuffer`, `DataView`, and `TypedArray` are in the supported-types list, so a `Uint8Array` or `ArrayBuffer` crosses the boundary by **copy** by default. This is the correct default for image bytes that will be displayed again on the sender side.
- **Transfer is zero-copy but detaches.** `ArrayBuffer` is a **transferable**. `worker.postMessage(msg, [buffer])` moves the underlying memory: the receiving side gets it, and the sender's buffer becomes unusable (`byteLength` becomes `0`; reads/writes throw). MDN: transferring an `ArrayBuffer` is "a fast and efficient zero-copy operation."
- **Typed arrays are not themselves transferable.** "Typed arrays like `Int32Array` and `Uint8Array` are serializable, but not transferable. However their underlying buffer is an `ArrayBuffer`, which is a transferable object." So the correct call is `postMessage(view, [view.buffer])` — pass the view in the message, list the **buffer** in the transfer list. `structuredClone(view, { transfer: [view.buffer] })` follows the same rule.
- **When it matters:** for the `search` tool, file text is small (KBs) and copying is irrelevant. For binary/image reads, a multi-MB image copied twice (worker→bridge→renderer) is wasteful; transfer is worth it when the sender genuinely relinquishes the bytes (e.g., handing a full-resolution buffer to the renderer for a one-shot conversion). If the same buffer must be reused, do not transfer it.
- **Repo-specific constraint:** `src/sandbox/protocol.ts` `assertSerializable` allows `Uint8Array` (`:67`) but explicitly rejects `Blob` and other `ArrayBuffer.isView` instances (`:74`) and `SharedArrayBuffer` (`:68-70`). So a binary read path must either add a dedicated message kind carrying `Uint8Array` (allowed today) or loosen the guard; a `Blob` must be converted to bytes before crossing. The existing `ToWorker`/`FromWorker` unions carry only `string` for fs payloads, so supporting bytes is a real protocol change, not a drop-in.

**Sources:** MDN Transferable objects (https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects); MDN Structured clone algorithm (https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm); HTML spec structured data (https://html.spec.whatwg.org/multipage/structured-data.html#transferable-objects).

---

## Architectural fit with this repo

- **`PyRunner` is already a persistent session;** `JsRunner` is not. Unifying them on one `SandboxSession` removes a real divergence (JS runs are isolated per call today, Python runs are not). This is a consolidation, not a rewrite.
- **Serialization is mandatory, not optional.** `py-worker.ts` holds all run state at module scope (`currentRunId`, `pendingFs`, `stdoutChunks`), so concurrent runs in one worker would corrupt each other. `PyRunner`'s queue already encodes this; a shared session must keep it for both languages.
- **`MessageChannel` is the right transport.** `PyRunner` hands a `MessagePort` to the worker; `MessagePort` is itself transferable (MDN list) and keeps fs RPC off the main worker channel. Keep this.
- **Idle reap must call the manager's `dispose` path too.** `JsRunner.dispose()` and `PyRunner.dispose()` both terminate; the reap should route through the same method so `activeWorkers`/`runs` bookkeeping stays consistent.
- **CSP interaction:** warm workers do not change the CSP posture. Vite still emits same-origin worker chunks that run without the document policy; the repo already records the resulting egress/IndexedDB exposure as an accepted residual risk. Persistence extends the lifetime of that exposure, which is worth re-checking in the plan but does not change the policy.
- **`search` belongs outside the sandbox.** It needs `WorkspaceApi` (main-thread `FileSystemDirectoryHandle`) and should not cross the string-only fs bridge per file. The current bridge (`executeFsCall`) returns `JSON.stringify(entries)` for `list`, so a recursive scan through it would be both chatty and alloc-heavy.

### Trade-off matrix

| Option | Latency (warm) | State retention | Isolation / reset | Complexity | Risk |
|---|---|---|---|---|---|
| Fresh worker per run (current JS) | High (reload each call) | None | Perfect | Low | Low, but loses warm Pyodide |
| Warm worker, no reset (current Py) | Low | Full, silent bleed | Weak | Low | Cross-run contamination, unbounded memory |
| Warm worker + per-session globals dict + idle reap (recommended) | Low | Controlled per session | Strong for Python names, weak for `sys.modules`/FS | Medium | Must document that imports/FS persist until terminate |
| Warm worker + `terminate()` reset button | Low except on reset | None after reset | Perfect after reset | Medium | Reset cost = full Pyodide reload |
| Interrupt via `setInterruptBuffer` | n/a here | n/a | n/a | High | **Not available** without COOP/COEP; do not design around it |

## Verified facts (with citations)

1. `pyodide@314.0.7` embeds Python 3.14.2, ABI `2026_0`, wasm32/emscripten_5_0_3; its lockfile ships 357 packages including `numpy`, `pandas`, and `micropip` 0.11.1. — `node_modules/pyodide/pyodide-lock.json` (`info`, `packages`), `node_modules/pyodide/package.json`.
2. `runPython`/`runPythonAsync` default their `globals` to `pyodide.globals`, so repeated calls on one runtime share state; passing an explicit dict namespace isolates a session. — `node_modules/pyodide/pyodide.d.ts:1643-1644, 1706-1707`; Pyodide FAQ https://pyodide.org/en/stable/usage/faq.html.
3. Pyodide in a web worker is loaded once and serves many messages from a single `onmessage` — the official example does exactly this. — https://pyodide.org/en/stable/usage/webworker.html.
4. `setInterruptBuffer(interrupt_buffer: TypedArray)` and `checkInterrupt()` **are** present in `pyodide@314.0.7`'s public API. — `node_modules/pyodide/pyodide.d.ts:1893,1902`; https://pyodide.org/en/stable/usage/api/js-api.html.
5. Interrupts require a web worker **and** a `SharedArrayBuffer`, which requires cross-origin isolation via `Cross-Origin-Opener-Policy` + `Cross-Origin-Embedder-Policy` **response headers**; without them the `SharedArrayBuffer` constructor is hidden and `postMessage` throws for SAB. This app has neither header. — https://pyodide.org/en/stable/usage/keyboard-interrupts.html; https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer; `vite.config.ts` (meta-only CSP), `index.html`.
6. `Worker.terminate()` "Immediately terminates the worker... it is halted at once"; it is the only standardized hard stop. No idle-timeout API exists on `Worker` (only `postMessage`/`terminate`). — https://developer.mozilla.org/en-US/docs/Web/API/Worker; https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate.
7. `WorkerGlobalScope` fires `error`, `unhandledrejection`, and `rejectionhandled` events; a persistent worker must handle these in-worker. — https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope.
8. `micropip.install()` installs pure-Python PyPI wheels and Pyodide wasm32/emscripten wheels from the CDN/custom URLs; `loadPackage()` has no PyPI dependency resolution; "loading a package twice is not permitted"; `loadPackagesFromImports()` resolves only lockfile packages, not PyPI. — https://pyodide.org/en/stable/usage/loading-packages.html.
9. `FileSystemDirectoryHandle.values()` is an async iterator usable with `for await...of`, Baseline since March 2023, available in workers, and throws `NotAllowedError`/`NotFoundError` in the documented cases. — https://developer.mozilla.org/en-US/docs/Web/API/FileSystemDirectoryHandle/values; https://fs.spec.whatwg.org/#api-filesystemdirectoryhandle-asynciterable.
10. Chrome's official guidance for enumerating a directory is to **not** `await` each `getFile()` sequentially but to resolve them in parallel (e.g. `Promise.all`). — https://developer.chrome.com/docs/capabilities/web-apis/file-system-access.
11. `Blob.arrayBuffer()` resolves to an `ArrayBuffer` via a promise; `Blob.size` is bytes; `Blob.type` is extension-derived and unreliable (renamed files misreport; uncommon types return `""`). — https://developer.mozilla.org/en-US/docs/Web/API/Blob/arrayBuffer; https://developer.mozilla.org/en-US/docs/Web/API/Blob/size; https://developer.mozilla.org/en-US/docs/Web/API/Blob/type.
12. The `File` from `FileSystemFileHandle.getFile()` becomes unreadable if the underlying file changes; call `getFile()` again. — https://developer.chrome.com/docs/capabilities/web-apis/file-system-access.
13. `ArrayBuffer` is transferable (zero-copy, sender detaches); `TypedArray`/`Uint8Array` are serializable but **not** transferable — transfer `view.buffer`. — https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects; https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm.

## Confidence / gaps

- **High confidence:** worker reuse semantics; Pyodide state persistence and `globals`; presence of `setInterruptBuffer`/`checkInterrupt` in 314.0.7; the SharedArrayBuffer/cross-origin-isolation requirement and this app's lack of COOP/COEP; `values()` async iteration; `Blob.arrayBuffer/size/type`; transferables vs structured clone.
- **Medium confidence:** browser-side caching behavior for micropip/Pyodide packages (inferred from `packageCacheDir` being Node-only plus standard HTTP caching; the docs do not state it outright). Exact practical concurrency cap for parallel `getFile()` calls (Chrome gives the rule, not a number).
- **UNVERIFIED — do not state as fact:**
  - Warm Pyodide RAM footprint for 314.0.7. No published number found. Only artifact sizes are known (wasm ~9.15 MiB, stdlib ~2.43 MiB).
  - A "standard idle-terminate pattern" for workers. No spec/API exists; any documented pattern is third-party convention.
  - Whether an in-worker `unhandledrejection` propagates as a parent `Worker` `error` event across all engines. MDN documents both events but not the propagation guarantee; install in-worker handlers rather than relying on it.
  - Any specific numeric size limit for `getFile()`/`arrayBuffer()` beyond this repo's own 2 MiB `DEFAULT_SIZE_CAP`.
  - Whether `pyodide.setInterruptBuffer` can interrupt a pure native tight loop that never calls `PyErr_CheckSignals()` (docs imply not; not explicitly stated for all cases).

## Unresolved questions

1. Should the idle-reap timer live in each runner or in `manager.ts`? The manager owns rebuild/dispose, but the runner owns the worker handle. Decide before implementation to avoid duplicate timers.
2. On reap-vs-respawn: is the intended reset UX a user-visible button, an automatic idle policy, or both? This determines whether `PyRunner`'s existing fatal-respawn path is reused as-is.
3. For `search`, what is the required glob/ignore semantics and result cap? This drives whether the walk needs to prune subtrees early rather than filter after `getFile()`.
4. For binary reads, is the consumer the model (needs text/base64 for the chat payload) or the UI (needs raw bytes for display)? That decides whether the fs bridge carries `Uint8Array` at all or converts to a data URI at the edge.
5. Is `crossOriginIsolated` ever a deployment goal? If yes, item 3's interrupt design changes materially; if no, record the terminate-only timeout as an accepted limitation.

## Source credibility note

Facts are anchored in (in descending weight): the installed package's own typings and lockfile (`node_modules/pyodide/*`, version-pinned and authoritative for "what 314.0.7 exposes"); WHATWG/W3C/MDN specs and references for browser behavior; Pyodide's own versioned docs (stable = 314.0.7, matching the installed package); Chrome's first-party capabilities guide for the one piece of concrete performance guidance. No tutorial or blog content was used for load-bearing claims.
