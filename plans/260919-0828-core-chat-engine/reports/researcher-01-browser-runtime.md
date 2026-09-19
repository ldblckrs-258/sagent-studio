# Researcher 01 — Browser Runtime Feasibility for the Chat Core

- **Plan:** `260919-0828-core-chat-engine`
- **Date:** 2026-09-19
- **Scope:** read-only reconnaissance of `sagent-studio` + external standards/browser research
- **Target stack (verified in-repo):** Vite `8.3.0` (Rolldown-based), React `19.2.8`, TypeScript `6.0.3`, Dexie `4.4.6`, Vitest `5.0.1`. CSP injected only on build by `vite.config.ts` via `<meta http-equiv="Content-Security-Policy">` (dev excluded, `apply: 'build'`).
- **Current CSP string (from `dist/index.html`, line 4):**
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; base-uri 'none'; form-action 'self'; object-src 'none'`
- **Key handling (verified in-repo):** `src/vault/crypto.ts` derives a **non-extractable** AES-GCM `CryptoKey` (`deriveKey(..., extractable=false, ['encrypt','decrypt'])`); `src/vault/store.ts:49` holds it in module-scope `let key: CryptoKey | null`. `src/vault/crypto.ts` is the only decrypt path.
- **Method:** query fan-out over WHATWG/W3C/CSP specs, MDN source markdown, `browser-compat-data`, Chrome for Developers, Pyodide docs/changelog/npm/unpkg, WPT tests, plus binary/byte-level inspection of Pyodide assets.

**Bottom line up front.** Every requested capability is technically reachable, but two facts invalidate the naive security model and must drive the design: (1) for a same-origin HTTP(S) worker, the document CSP — meta or header — **does not govern the worker's `eval`/`new Function`/`import()`/WebAssembly, nor the worker's `fetch`**; the worker's own response CSP does. Because this project injects CSP via `<meta>`, the worker chunk currently has no policy at all, so it is unbounded. (2) `CryptoKey` and `FileSystemDirectoryHandle` are both structured-cloneable, so the vault key or a folder handle can be leaked across the bridge by a single careless `postMessage`. Both are fixable, but only with a worker **response-header** CSP and a strict bridge — not with the meta tag alone.

---

## 1. File System Access API (`showDirectoryPicker`)

### 1.1 Support status (2026)

| Capability | Chrome/Edge | Chrome Android | Firefox | Safari |
|---|---|---|---|---|
| `Window.showDirectoryPicker()` / `showOpenFilePicker()` / `showSaveFilePicker()` | 86 | 132 | **No** | **No** |
| `FileSystemHandle.queryPermission()` / `requestPermission()` | 86 | 109 | **No** | **No** |
| `FileSystemHandle` (core handle object) | 86 | 109 | 111 | 15.2 |
| `StorageManager.getDirectory()` (OPFS) | 86 | 109 | 111 | 15.2 |

Sources: `browser-compat-data` `api/Window.json` and `api/FileSystemHandle.json` (fetched from `raw.githubusercontent.com/mdn/browser-compat-data/main/...`), and the Chrome doc "The File System Access API" (published 2024‑08‑19, explicitly states Firefox and Safari "not supported", Brave flag-gated). The separability matters: **Firefox and Safari implement the handle/OPFS layer but not the user-visible folder picker or the permission methods.** A "user-granted local folder" is therefore a Chromium-only feature.

### 1.2 Exact API shapes

The picker and permission methods are still in the **WICG draft** (`https://wicg.github.io/file-system-access/`), not the WHATWG standard. The core handle/stream interfaces are now in the **WHATWG File System Standard** (`https://fs.spec.whatwg.org/`, verified: 83 `FileSystemHandle` references, 0 `showDirectoryPicker`). Exact IDL from the WICG draft:

```webidl
enum FileSystemPermissionMode { "read", "readwrite" };

dictionary FileSystemHandlePermissionDescriptor { FileSystemPermissionMode mode = "read"; };

[Exposed=(Window, Worker), SecureContext, Serializable]
partial interface FileSystemHandle {
  Promise<PermissionState> queryPermission(optional FileSystemHandlePermissionDescriptor descriptor = {});
  Promise<PermissionState> requestPermission(optional FileSystemHandlePermissionDescriptor descriptor = {});
};

dictionary DirectoryPickerOptions {
  DOMString id;
  StartInDirectory startIn;              // FileSystemHandle or "desktop"|"documents"|"downloads"|"music"|"pictures"|"videos"
  FileSystemPermissionMode mode = "read";
};

[SecureContext]
partial interface Window {
  Promise<FileSystemDirectoryHandle> showDirectoryPicker(optional DirectoryPickerOptions options = {});
};
```

Note the spec enum is only `"read"` / `"readwrite"`; the MDN `requestPermission` page also lists `"write"`, which is **stale relative to the WICG draft** (treat `"write"` as UNVERIFIED / not in the enum). `PermissionState` = `'granted' | 'denied' | 'prompt'`.

Enumeration/mutation (WHATWG File System Standard): `FileSystemDirectoryHandle.getFileHandle(name, {create})`, `getDirectoryHandle(name, {create})`, `removeEntry(name, {recursive})`, async iterators `values()`/`entries()`/`keys()`, `resolve(possibleDescendant)`; `FileSystemFileHandle.getFile(): Promise<File>`, `createWritable(): Promise<FileSystemWritableFileStream>` (`write()`, `seek()`, `truncate()`, `close()`; disk writes land on `close()`).

### 1.3 Persisting a handle across reloads

`FileSystemHandle` is `[Serializable]`, and MDN's structured-clone list now includes `FileSystemHandle`, `FileSystemFileHandle`, and `FileSystemDirectoryHandle`. So a handle survives **structured clone into IndexedDB** and `postMessage` between same top-level origin. The Chrome doc's canonical code stores it with `idb-keyval` (`get`/`set`). With the project's existing Dexie DB this is a `Table<{ id: string; handle: FileSystemDirectoryHandle }>`.

The critical caveat, stated in both the Chrome doc and MDN: **persisting the handle does not persist the permission.** After a reload, a handle read from IndexedDB typically reports `queryPermission() === 'prompt'` (MDN `queryPermission` docs say exactly this), and operations reject until `requestPermission()` is granted within a **transient user activation** (a real click; MDN: "There was no transient user activation … This includes when the handle is in a non-Window context which cannot consume user activation, such as a worker"). Therefore call `queryPermission`/`requestPermission` **only from the main thread and only from a user gesture**. The standard `verifyPermission` pattern from MDN/Chrome is:

```js
async function verifyPermission(handle, readWrite) {
  const opts = readWrite ? { mode: 'readwrite' } : {};
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if ((await handle.requestPermission(opts)) === 'granted') return true;
  return false;
}
```

Chrome 122+ adds **persistent permissions** (three-way prompt: "Allow this time" / "Allow on every visit" / "Don't allow"). Per the Chrome "Persistent permissions…" post, the prompt only appears when: (a) the app already stored the handle in IndexedDB on a prior visit and calls `requestPermission()` on a handle from that store; (b) the grant was auto-revoked after the tab was backgrounded; or (c) the app is **installed** (then it is automatic). One-time grants expire when the last tab of the origin closes, and Chrome auto-revokes one-time permissions for backgrounded tabs. `requestPermission` is suppressed after ~3 denials/dismissals.

### 1.4 Firefox / Safari degradation

Feature-detect with `typeof window.showDirectoryPicker === 'function'` (Chrome doc's pattern uses `'showDirectoryPicker' in self`). Choose fallbacks:

1. **OPFS read/write cache** (`navigator.storage.getDirectory()`) — supported in FF 111+/Safari 15.2+; good for an app-managed workspace but not for touching the user's real disk.
2. **Read-only `<input type="file" webkitdirectory>`** — supported by all three engines; gives a one-shot directory snapshot with no persistence and no write.
3. Surface an explicit "local folder tools need Chromium" state rather than silently failing.

Do **not** try to call `requestPermission` from a worker for the fallback path — it throws `SecurityError` (no user activation in a worker context).

### 1.5 Adoption risk

Maturity is acceptable *for Chromium* (stable since 86, plus the 122 persistent-permission improvement), but the API is still WICG-level for the picker/permission surface, non-Baseline, and has no Firefox/Safari timeline. Treat multi-browser parity as out of scope unless the product explicitly drops FF/Safari for file tools. `FileSystemHandle.move()` remains partial (no directory moves).

---

## 2. Running arbitrary JavaScript in a Web Worker under CSP

### 2.1 What the spec actually says (and where MDN agrees)

The governing algorithm is HTML Standard §7.1.7, **"initialize a worker global scope's policy container"**:

1. If the worker's URL **is local but its scheme is not `blob`** → the worker's policy container is a **clone of the owner's** policy container (CSP list included). `about:` and `data:` qualify.
2. Otherwise → the worker's policy container is created **from its own fetch response**.

"Local scheme" is defined in Fetch §2.1 as **`"about"`, `"blob"`, `"data"`** — *not* `http`/`https`. Therefore a **same-origin HTTP(S) worker does not clone the owner's policy container; it derives its policy from its own response headers.** For `blob:` workers, Fetch's "create a policy container from a fetch response" returns a clone of the blob URL entry's environment policy container, i.e. the creator's — so blob workers *do* inherit.

This is confirmed by MDN's "Using Web Workers" CSP section ("workers … are, in general, not governed by the content security policy of the document … To specify a content security policy for the worker, set a Content-Security-Policy response header for the request which delivered the worker script itself. The exception … is if the worker script's origin is a globally unique identifier (… `data` or `blob`). In this case, the worker does inherit the CSP of the document") and by the WPT test `content-security-policy/inside-worker/dedicatedworker-script-src.html`, whose comments read *"Dedicated workers do not inherit CSP in general"* and *"Dedicated workers honor CSP received in their response headers."* The WPT support workers assert that with no CSP, `eval("1+1")`, `new Function("return 1+1;")()`, `setTimeout("…string…")` and cross-origin `importScripts()` all succeed; with a response header `script-src 'self'`, `eval`/`new Function` throw `EvalError`.

**Answers to the sub-questions:**
- `new Function` / `eval` / dynamic `import()` inside a **same-origin http(s)** worker is governed by the **worker's own** policy, **not** the owner document's `script-src`.
- `'unsafe-eval'` in the document CSP covers the worker **only if the worker is created from a `blob:` or `data:` URL** (which inherit). For an http(s) worker it does **not** reach the worker.
- Dynamic `import()`/`importScripts()` in an http(s) worker: same story — the worker's own policy. (If you *do* add a worker response CSP, the worker's static/dynamic imports are "script" destination → checked against `script-src-elem` → `script-src` → `default-src`; see CSP3 §6.8.1.)

### 2.2 Creating the worker *is* governed by the document

The document CSP still gates `new Worker(...)`: the fetch has destination `worker`, whose effective directive is `worker-src` with fallback chain `worker-src → child-src → script-src → default-src` (CSP3 §6.8.1). CSP3 §6.1.10 adds: *"script-src-elem is not used as a fallback for the worker-src directive. The worker-src checks still fall back on the script-src directive."* The project currently has no `worker-src`; `script-src 'self'` already allows a same-origin worker by fallback.

### 2.3 Vite bundling and directive sufficiency

Vite's documented, recommended pattern is `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`; worker detection requires the `new URL()` to literally be inside `new Worker()`, and all options must be static. In **build**, Vite emits the worker as a separate **same-origin hashed asset** (regardless of module/classic), so there is **no `blob:`/`data:` URL** and no inheritance. `worker-src 'self'` is therefore sufficient to create it; it is already implicitly satisfied by `script-src 'self'`.

- Do **not** use `?worker&inline`: Vite documents it as "Web Workers inlined as base64 strings at build time" (implemented as a Blob/object URL). That yields a `blob:` worker, which inherits the document CSP and would then *require* `'unsafe-eval'` in the document **and** `worker-src blob:` (or `script-src blob:`) to run model JS. This silently changes the trust model — avoid it.

### 2.4 Exact directive additions required

**Document `<meta>` (build), per the accepted relaxation:**

```
script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self'
```

- `'unsafe-eval'` covers `eval`/`Function()`/`setTimeout(string)`; per MDN it also "overrides … `'wasm-unsafe-eval'`", so `'unsafe-eval'` alone permits WebAssembly too. Listing both is explicit and harmless; if you want the tighter policy use only `'wasm-unsafe-eval'` and rely on the worker's own (empty) policy for JS eval.
- `worker-src 'self'` is defensive/explicit (already reachable via `script-src 'self'` fallback). Keep it if `script-src` is ever tightened.
- A `<meta>` CSP applies every directive *except* `frame-ancestors`, `report-uri`, and `sandbox`; `worker-src` **is** meta-capable.
- **`blob:` is not needed** on the document for the `new URL()` worker; add `worker-src 'self' blob:` only if you adopt `?worker&inline`.

**Critical gap:** none of that bounds the worker's *internals* (eval permission, `connect-src`, nested workers). Because HTTP(S) workers take their policy from their own response, **the only way to put a CSP on the worker is a response header on the worker asset.** `vite.config.ts`'s build-only `<meta>` injection cannot reach the worker chunk, and a meta tag cannot be applied to a worker global at all. Concretely you need an HTTP header such as:

```
Content-Security-Policy: script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'
```

delivered by the host in production (and, for parity, a `configureServer` middleware in dev). Without it, an http(s) worker is **completely unrestricted** — including its `fetch`, which bypasses the document `connect-src`. That is the exfiltration hole discussed in §4.

**Adoption/verification risk:** the spec + WPT + MDN are consistent, but this inverts the common assumption that the document CSP follows the worker. Mark live-browser confirmation of the "no worker response CSP → eval allowed" path as UNVERIFIED until an empirical spike runs (see Limitations).

---

## 3. Pyodide self-hosted under Vite 8

### 3.1 Package and loading without a CDN

- **Version:** `pyodide@314.0.7` (npm registry `dist-tags.latest`; `unpackedSize` 13,879,282 bytes; `fileCount: 14`). This is the current release train; `loadPyodide` exported as ESM from `pyodide.mjs`, with `.d.ts` at `pyodide.d.ts`.
- **Self-host:** `npm i pyodide`, then copy the runtime files to a same-origin static dir (e.g. `public/pyodide/`) — or import `{ loadPyodide } from 'pyodide'` and pass `{ indexURL: '/pyodide/' }`. `loadPyodide` defaults `indexURL` to the loader's own directory; `lockFileURL`/`stdlibURL`/`packages` are configurable. The files that must be present are `pyodide.asm.mjs`, `pyodide.asm.wasm`, `python_stdlib.zip`, `pyodide-lock.json` (plus optionally `pyodide.mjs`).
- **MIME/CORS:** the server must serve `pyodide.asm.wasm` as `application/wasm` (Pyodide docs: any static host "that correctly sets the WASM MIME type").
- **Bundle interaction:** `.wasm` ≥ Vite's `assetsInlineLimit` stays a fetched file (Vite inlines only small wasm as base64), which is what we want. Keep the pyodide directory out of the JS chunk graph so it is fetched at runtime, not bundled.

### 3.2 Verified asset sizes (from `unpkg.com/pyodide@314.0.7/?meta`)

| File | Bytes | MiB |
|---|---:|---:|
| `pyodide.asm.wasm` | 9,598,218 | 9.15 |
| `python_stdlib.zip` | 2,545,637 | 2.43 |
| `pyodide.asm.mjs` | 1,250,344 | 1.19 |
| `pyodide-lock.json` | 119,077 | 0.11 |
| `pyodide.mjs` (loader) | 17,931 | 0.017 |
| **Core total (npm unpacked)** | **13,879,282** | **~13.2** |

The full GitHub release (`pyodide-314.0.7.tar.bz2`) is "200+ megabytes" (docs) because it vendors many wheels; the **core** tarball is what npm installs. First-load transfer is smaller than raw because servers gzip/brotli the `.wasm` and `.zip` (a 3–4 MB transfer is typical for the wasm alone), but the **exact compressed transfer and first-load latency were not measured here — UNVERIFIED.** Plan for a multi-second cold start on a cold cache and cache the assets aggressively.

### 3.3 Does Pyodide need `eval`/`new Function`? (verified empirically)

Byte-level inspection of `pyodide.asm.mjs` (v314.0.7):

- `new Function` occurrences: **0**.
- `eval(` occurrences: **6**, all Emscripten runtime paths: `_emscripten_run_script(ptr){ … eval(UTF8ToString(ptr)) }`, `runEmAsmFunction`/`ASM_CONSTS` (`eval(func)`), the `__start_em_asm`/`moduleExports` `eval(func)` paths, and a Node-only dynamic `eval(data)` loader branch. None are on the normal browser Python-execution path.
- `createObjectURL` is used only for `Image`/`Audio` decoding; **no `blob:` and no Pyodide-authored `new Worker`** (1 incidental `new Worker` match; `importScripts` appears only in runtime-detection strings). The loader `pyodide.mjs` uses `WebAssembly.compile(...)` for an inline helper wasm and dynamic `import()` for `pyodide.asm.mjs`.

The Pyodide changelog states the policy directly (v0.22-era entry, PR #3075):

> "Pyodide now works with a content security policy that doesn't include `unsafe-eval`. It is still necessary to include `wasm-unsafe-eval` (and probably always will be). Since current Safari versions have no support for `wasm-unsafe-eval`, it is necessary to include `unsafe-eval` in order to work in Safari."

This matches GitHub issue `pyodide/pyodide#3141` ("I need to add `unsafe-eval` … I would be great to be able to use `wasm-unsafe-eval` instead"), which is closed.

**Conclusion for CSP:**
- Required: **`'wasm-unsafe-eval'`** (WebAssembly compile/instantiate).
- Not required for normal operation: `'unsafe-eval'` (since v0.22), **except** on browsers lacking `wasm-unsafe-eval`. Per `browser-compat-data`, `wasm-unsafe-eval` is Chrome 97, Firefox 102, **Safari 16**; the Safari caveat applies only to Safari 15.x. Given the accepted relaxation, include `'unsafe-eval'` in the **document and worker** policy for maximum compatibility (it subsumes `wasm-unsafe-eval`).
- `blob:` is **not** needed for Pyodide's own loading.
- Remember from §2: if you set a worker response CSP, `'wasm-unsafe-eval'` must be in **that** policy, not only the document's.

### 3.4 Running Python in a worker with a timeout / terminate kill switch

Pyodide **requires a module-type worker** (`pyodide.asm.mjs` is an ES module; classic workers via `importScripts()` are unsupported — the loader even throws "Classic web workers are not supported"). The documented pattern is a module worker holding `loadPyodide()` in a promise, receiving `{ id, python, context }`, calling `pyodide.loadPackagesFromImports(python)` then `pyodide.runPythonAsync(...)`, and `postMessage`-ing back `{ id, result | error }`.

**Timeout/kill — the only reliable switch here is `Worker.terminate()`.** Python runs synchronously on the worker's single thread; an infinite loop cannot yield. Pyodide's cooperative interrupt, `pyodide.setInterruptBuffer(interrupt_buffer)`, explicitly requires *"a SharedArrayBuffer shared with the main browser thread"*. `SharedArrayBuffer` requires a cross-origin-isolated document (COOP `same-origin` + COEP `require-corp`/`credentialless` `Permissions-Policy: cross-origin-isolated`), which needs **HTTP response headers** — a `<meta>` CSP cannot set them, and this app sets neither. So `crossOriginIsolated` is `false`, `setInterruptBuffer` is unavailable, and the design must be:

1. `const worker = new Worker(new URL('./py-runner.ts', import.meta.url), { type: 'module' })`.
2. Main thread arms a wall-clock timer; on expiry call `worker.terminate()` (MDN: "The worker thread is killed immediately"), then discard the worker and spawn a fresh one + re-`loadPyodide` for the next run.

Frequent kills re-pay the ~13 MB load; a warm long-lived worker plus terminate-on-timeout is the pragmatic trade. (Pyodide FS persistence via `FS.syncfs()` to IDBFS is possible but out of scope here.)

**Integration bonus:** Pyodide already ships a native-FS adapter (`NATIVEFS_ASYNC`) mountable from a `FileSystemDirectoryHandle` (the loader contains `mount`/`getRemoteSet`/`storeRemoteEntry` using `values()`, `getFileHandle`, `createWritable`). It could mount the same handle obtained in §1, letting Python read/write the granted folder — but doing so stacks Python's capability on top of the worker's, which sharpens the containment decision in §4.

---

## 4. Worker sandbox isolation facts

**What a dedicated worker cannot do:** it has no access to the main thread's JS memory, variables, or globals — it is a separate global scope (`DedicatedWorkerGlobalScope`) in a separate agent/heap; `window`, `document`, and DOM are absent. Communication is only `postMessage`/`MessageChannel`, and data is **copied, not shared** (structured clone). **Shared memory is unavailable here:** `SharedArrayBuffer` requires `crossOriginIsolated === true` (COOP+COEP headers), which this app cannot set, so no `SharedArrayBuffer`/`Atomics` and no shared heap between threads.

**What it can do (MDN "Functions and classes available to workers"):** `fetch`/`XMLHttpRequest`, **IndexedDB**, **Web Crypto** (`Crypto`/`SubtleCrypto` are `[Exposed=(Window,Worker)]` per the WebCrypto spec), **File System API**, Cache Storage, OPFS, `BroadcastChannel`, WebSockets, `postMessage`, `structuredClone`, timers, and nested workers. It cannot use `localStorage`/`sessionStorage`, and `navigator.storage.persist()` is not available (only `persisted()` — see §5).

### 4.1 The CryptoKey leak (spec-verified, high severity)

The WebCrypto Level 2 editor's draft (11 Aug 2026) declares `[SecureContext, Exposed=(Window,Worker), Serializable] interface CryptoKey` and defines serialization steps (§13.5) that set `serialized.[[Handle]]` from the key's internal handle — **with no `extractable` guard**. §5.2 and §6.2 explicitly contemplate storing/sharing `CryptoKey`s via IndexedDB and `postMessage`, and MDN's structured-clone list now includes `CryptoKey`.

Implication: the vault key is non-extractable, so raw bytes cannot be `exportKey`'d, **but a structured clone still carries the `[[handle]]` and remains usable for `encrypt`/`decrypt` in the worker.** A single `worker.postMessage(vaultKey)` would hand model-authored code the ability to decrypt the vault and to exfiltrate plaintext. **Rule: never place `CryptoKey` objects — or anything derived from the key — on any `postMessage`.** (Live-browser confirmation of the clone behavior is UNVERIFIED; treat as cloneable and design as if it always is.)

### 4.2 Residual exfiltration risks (what a worker can still do)

- **`fetch` is unconstrained by the document `connect-src`.** An http(s) worker with no response CSP has no policy, so it can `fetch` arbitrary `https://` endpoints with arbitrary payloads — the project's careful `connect-src` list does **not** apply inside the worker. Anything the worker can read it can ship off-origin.
- **Same-origin storage is readable.** The worker can open the `sagent-vault` IndexedDB and read the encrypted blob (and any other same-origin IndexedDB/Cache/OPFS data). It cannot decrypt without the key (not reachable if the bridge is correct), but it can exfiltrate ciphertext and any non-secret data.
- **It can call back into the main thread.** A compromised worker can `postMessage` well-formed-looking requests and attempt to induce privileged bridge operations (tool-call prompt injection, arbitrary file reads/writes) — this is the most realistic escalation path.
- **It can persist and fan out**: nested workers, `BroadcastChannel`, service-worker registration (same origin), OPFS writes.
- **File handles are cloneable too** (`FileSystemDirectoryHandle` is `[Serializable]`). Passing a granted handle into the worker grants it direct, permission-bound disk read/write — bypassing the main-thread bridge entirely.

### 4.3 Bridge design that minimizes reach (ranked)

**Recommended (Option B, "thin capability bridge"):**
1. **Main thread owns everything privileged**: the `CryptoKey`, the vault, and all `FileSystemDirectoryHandle` I/O. Never send the key or a handle to the worker.
2. The worker receives only a serializable payload of *inputs* for one run (`{ runId, source, globals? , cwdId? }`) and returns `{ runId, ok, value | error }`.
3. **All file access is a main-thread RPC**: the worker posts `{ kind: 'fs.read', path }` / `{ kind: 'fs.write', path, data }`; the main thread validates the path stays under the granted root, applies policy, and performs the op. The untrusted side never sees the handle.
4. **Strict schema + correlation**: discriminated-union messages validated on both ends; unknown shapes rejected/ignored; one worker per run (or terminate+respawn after timeout) so no state carries over.
5. **Serialize everything through structured clone explicitly** (strings/typed arrays/plain objects only); ban functions, handles, and keys.
6. Give the worker a **response-header CSP** (§2.4) with `connect-src 'self'` so its own `fetch` cannot reach the internet, plus `worker-src 'none'` to stop nested workers — with the caveat that once `connect-src 'self'` is set, legitimate provider calls must originate on the main thread.

**Rejected (Option A, "unrestricted worker"):** same-origin worker, no response CSP. Code runs with zero policy; model JS can fetch anywhere. Only acceptable if you explicitly accept "untrusted code has the same network reach as the page" — it does **not** meet the stated "key must never be reachable" intent's spirit, even though the key itself stays out of reach if the bridge is correct.

**Trade-off matrix**

| Dimension | A: unrestricted worker | B: capability bridge + worker response CSP |
|---|---|---|
| Eval/JS execution | works (no policy) | works (`'unsafe-eval'` in worker header) |
| Worker network egress | unbounded (`https:` anywhere) | bounded to `connect-src 'self'` |
| Key reachable | no (if bridge correct) | no |
| Folder handle reachable | easy to leak by accident | never crosses the bridge |
| Complexity | low | medium (RPC protocol, path policy, header plumbing) |
| Dev/prod parity | trivial | needs dev `configureServer` middleware |

---

## 5. `navigator.storage.persist()` interactions

**Semantics.** `StorageManager.persist(): Promise<boolean>` requests that the origin's storage bucket be exempt from eviction; `StorageManager.persisted(): Promise<boolean>` reads the current state without prompting (MDN). Support (`browser-compat-data` `api/StorageManager.json`): `persist`/`persisted` — Chrome 55, Firefox 57, Safari 15.2. **`persist()` is not available in Worker scope; `persisted()` is.** The project already implements this correctly: `readPersisted()` calls `navigator.storage.persisted()` (never prompts), `askPersisted()` calls `persist()` from the unlock gesture, and the live `persisted()` reading overrides the stored `MetaRecord.persistedStorage` flag on unlock (`src/vault/store.ts:65–95, 156–186`).

**Relationship to `FileSystemDirectoryHandle` permission — they are independent systems.**
- `persist()` governs **storage-bucket eviction** (IndexedDB, Cache, OPFS). It does **not** grant, persist, or restore any filesystem-handle permission. A granted handle is a *user* grant to real disk, tracked by the File System Access permission model, not by the storage bucket.
- Handle grants have their own lifecycle (§1.3): `queryPermission`/`requestPermission` on the main thread, transient-user-activation required, auto-revocation of one-time grants, and Chrome 122+ "Allow on every visit" persistence.
- Practical interaction: storing the handle in IndexedDB is more likely to survive if the bucket is persistent (an evicted bucket loses the stored handle), so `persist()` indirectly improves the odds the *handle record* survives — but the *permission* may still be `'prompt'` after reload. **These are two separate booleans; do not conflate them in UI copy.**
- Recommended state split: keep `MetaRecord.persistedStorage` meaning exactly "storage will not be evicted", and add a distinct, per-session **folder-permission state** (`granted`/`prompt`/`denied`) re-verified via `queryPermission` each session.
- Schema implication (in-repo): `src/vault/db.ts` is at `version(1)` with `vault` + `meta`. Persisted handles need a new table, i.e. `this.version(2).stores({ ... vault: 'id', meta: 'id', fs: 'id' })` (or a sibling non-vault Dexie DB). Handles must not be encrypted into the vault blob (they are structured-clone objects, not JSON) — store them as first-class IndexedDB values.

**Adoption risk:** low, but note the browser heuristics differ (Chromium decides silently from engagement; Firefox prompts), and Safari only gained `persist()` at 15.2.

---

## Ranked recommendations

1. **Adopt Option B (capability bridge + worker response-header CSP).** It is the only design that honors "the vault key must never be reachable by executed code" *and* keeps the worker's network egress bounded. Deliver a CSP **response header** for the worker asset (prod host + dev `configureServer` middleware), because `<meta>` CSP provably cannot reach an http(s) worker.
2. **Add to the document meta policy:** `script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self'`. Keep the existing `connect-src` list for the main thread; accept that it does not constrain the worker — the worker header does.
3. **Never `postMessage` a `CryptoKey` or a `FileSystemDirectoryHandle`.** Add an explicit serialize allow-list at the bridge boundary and a unit test that asserts a `CryptoKey`/handle send attempt is rejected.
4. **Self-host Pyodide 314.0.7** from `public/pyodide/` with `indexURL`, module worker, `'wasm-unsafe-eval'` (+ `'unsafe-eval'` for Safari 15 / simplicity) — and `Worker.terminate()` as the only timeout mechanism (no `SharedArrayBuffer`).
5. **Gate folder tools on Chromium** with OPFS / read-only directory-input fallbacks for Firefox and Safari; re-verify handle permission from a user gesture each session.
6. **Add a Dexie v2 table for FS handles** and keep the `persistedStorage` flag semantically separate from folder permission.

## Unresolved questions / limitations

- **UNVERIFIED — worker CSP inheritance in live browsers.** Spec + WPT + MDN agree that same-origin http(s) workers do not inherit the document CSP, but this was not executed in a real browser. Run a spike: serve a worker with and without a CSP response header, assert `eval`/`new Function`/WASM behavior, and confirm `crossOriginIsolated === false`. Also confirm a `blob:` worker does inherit.
- **UNVERIFIED — `CryptoKey` structured clone in current Chrome/Firefox/Safari.** The spec says serializable; behavior may lag. Test `worker.postMessage(key)` and, if it throws `DataCloneError`, keep the never-send rule anyway.
- **UNVERIFIED — Pyodide compressed transfer size and cold-start latency** on the target hardware; raw sizes only were verified.
- **Not covered:** Python wheel availability/sizes beyond the core; provider-side `connect-src` allow-listing once the worker is constrained to `'self'` (the LLM call must stay on the main thread); service-worker-based CSP delivery.
- **Cross-cutting:** the existing `vite.config.ts` comment ("script-src 'self' is the containment control that must not be relaxed") is contradicted by §2 for worker-hosted code — the containment control must move to a worker response header.

## Sources

- MDN: [Window.showDirectoryPicker](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker), [FileSystemHandle.queryPermission](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemHandle/queryPermission), [FileSystemHandle.requestPermission](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemHandle/requestPermission), [Structured clone algorithm](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm), [Functions available to workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Functions_and_classes_available_to_workers), [Using Web Workers (CSP section)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers), [StorageManager.persist](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist), [StorageManager.persisted](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persisted), [Window.crossOriginIsolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated), [CSP script-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src), [CSP worker-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/worker-src)
- Specs: [WHATWG HTML §7.1.7 policy containers + initialize worker global scope's policy container](https://html.spec.whatwg.org/multipage/browsers.html#initialize-worker-policy-container), [HTML §10 Web workers](https://html.spec.whatwg.org/multipage/workers.html), [WHATWG Fetch §2.1 local scheme](https://fetch.spec.whatwg.org/#local-scheme), [W3C CSP3](https://w3c.github.io/webappsec-csp/) (§6.8.1 effective directive, §6.2.2 worker-src, §6.1.10 script-src, §2.3 wasm-unsafe-eval), [WICG File System Access](https://wicg.github.io/file-system-access/), [WHATWG File System Standard](https://fs.spec.whatwg.org/), [W3C WebCrypto Level 2 §5.2/§13.5](https://w3c.github.io/webcrypto/)
- Browsers: [Chrome — The File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access), [Chrome — Persistent permissions for the File System Access API](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api)
- Compat data: `mdn/browser-compat-data` `api/Window.json`, `api/FileSystemHandle.json`, `api/StorageManager.json`, `http/headers/Content-Security-Policy.json`
- Vite: [Features — Web Workers](https://vite.dev/guide/features#web-workers) and [CSP](https://vite.dev/guide/features#content-security-policy-csp) (v8.3.0)
- WPT: `content-security-policy/inside-worker/dedicatedworker-script-src.html`, `.../support/script-src-allow.sub.js`, `.../support/script-src-self.sub.js`, `content-security-policy/worker-src/dedicated-worker-src-script-fallback.sub.html`
- Pyodide: [Downloading and deploying](https://pyodide.org/en/stable/usage/downloading-and-deploying.html), [Using Pyodide in a web worker](https://pyodide.org/en/stable/usage/webworker.html), [FAQ](https://pyodide.org/en/stable/usage/faq.html), [JS API](https://pyodide.org/en/stable/usage/api/js-api.html), [changelog](https://github.com/pyodide/pyodide/blob/main/docs/project/changelog.md) (PR #3075), [issue #3141](https://github.com/pyodide/pyodide/issues/3141), npm `pyodide@314.0.7` (`registry.npmjs.org/pyodide/latest`), `unpkg.com/pyodide@314.0.7/?meta`
