# Probe 01 — External library loading in the sandbox runners

Status: done (2026-09-20)
Scope: `run_js` / `run_python` (`src/sandbox/*`), plus the preview frames for comparison.
Question: can model-authored code pull in libraries outside the bundle, and why does
`pyodide.loadPackage('numpy')` fail?

Re-runnable companion: `public/sandbox-lib-lab.html` (serve it, open it, press Re-run).

## 1. Network egress works, from both languages

Both runners reach the public internet. This is not an oversight: it is the recorded
accepted risk.

- `plans/260919-0828-core-chat-engine/phase-05-code-runners.md` (Security Considerations):
  *"Accepted residual risk: worker code has page-equivalent network reach, recorded in `plan.md`"*.
- `vite.config.ts` (CSP comment): a same-origin http(s) worker does not inherit the document
  CSP, so the runner chunk runs with no document policy and "has page-equivalent network egress".
  The document CSP `connect-src 'self' https: http://localhost:* http://127.0.0.1:*` already
  allows `https:`.

Measured, from `run_js`: `fetch('https://cdn.jsdelivr.net/npm/lodash@4.17.21/package.json')` → 200.
Measured, from `run_python`: `pyfetch(...same URL...)` → 200.

So nothing needs to be "unblocked" for library loading. The gap is elsewhere (§4).

## 2. JS — three recipes that work

All three were executed in `run_js` and returned real results.

**a. ESM via jsDelivr `/+esm` — preferred for real named exports**

```js
const lodash = await import('https://cdn.jsdelivr.net/npm/lodash-es@4.17.21/+esm')
lodash.sum([1, 2, 3, 4]) // 10
```

`Object.keys(namespace)` is populated (full lodash-es export list), and `lodash.chunk` is a function.

**b. ESM via esm.sh — preferred for subpath entry points**

```js
const { default: format } = await import('https://esm.sh/date-fns@3.6.0/format')
format(new Date(Date.UTC(2024, 0, 2)), 'yyyy-MM-dd') // '2024-01-02'
```

Cold cost measured: 154 ms.

**c. UMD/CJS bundle via `fetch` + `Function` — the closest thing to `require`**

```js
const source = await (await fetch('https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js')).text()
const shim = { exports: {} }
const factory = new Function('module', 'exports', source + '\n;return module.exports;')
const marked = factory(shim, shim.exports)
marked.parse('# hello **world**') // '<h1>hello <strong>world</strong></h1>\n'
```

35 479 bytes fetched; a full CommonJS-style shim. `js-worker.ts` already builds the run body with
`AsyncFunction`, so `await import(...)` and `new Function` are both available to model code.

**Pitfall worth knowing:** importing a UMD bundle as a module *succeeds* but yields an empty
namespace, because the bundle writes to `globalThis` instead of exporting. `await import(...)` of
`dayjs@1.11.10/dayjs.min.js` returned `Object.keys(namespace) === []`, while `globalThis.dayjs`
became callable (`dayjs('2024-01-02').format('YYYY/MM/DD')` → `2024/01/02`). Use `/+esm` or esm.sh
when you want an importable namespace; use the `Function` shim when you want module-local state
without touching globals.

## 3. JS — `importScripts` needs a blob classic worker

The runner worker is an ES module worker (`worker-factory.ts` / `js-runner.ts:8` use
`{ type: 'module' }`, and `vite.config.ts` sets `worker: { format: 'es' }`). Therefore, in the runner
worker itself:

```
Failed to execute 'importScripts' on 'WorkerGlobalScope': Module scripts don't support importScripts().
```

`typeof importScripts === 'function'` there, which makes this fail late rather than at parse time.

The workaround is to mint a classic worker from a blob and let *that* use `importScripts`:

```js
const src = "self.onmessage=function(){importScripts('https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js');postMessage({v:self._.VERSION,sum:self._.sum([1,2,3,4])})}"
const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))
const worker = new Worker(url) // classic: no { type: 'module' }
// → { v: '4.17.21', sum: 10 }
```

Verified working. This also gives a second isolation boundary: the library's globals land in the
child worker, not in the standing runner session.

## 4. Python — why `loadPackage('numpy')` fails

**The self-hosted Pyodide directory contains no package wheels.** `scripts/copy-pyodide.mjs` copies
exactly five core files:

```
pyodide.mjs, pyodide.asm.mjs, pyodide.asm.wasm, python_stdlib.zip, pyodide-lock.json
```

`pyodideIndexUrl()` (`src/sandbox/py-worker.ts:33`) resolves to `http://localhost:5173/pyodide/`, and
the lockfile is served from the same base, so `loadPackage(name)` builds
`…/pyodide/numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl` — a file that was never copied.
Vite's SPA fallback then answers **200 with `index.html`**, which Pyodide reports as a fetch failure:

| URL served from `localhost:5173/pyodide/` | status | content-type |
|---|---|---|
| `pyodide-lock.json` | 200 | `application/json` |
| `pyodide.asm.wasm` | 200 | `application/wasm` |
| `numpy-2.4.6-…-wasm32.whl` | 200 | **`text/html` (SPA fallback)** |

Observed from `run_python`:

```
Loading numpy
Failed to load numpy
{'err': 'ModuleNotFoundError("No module named \'numpy\'")'}
stderr: The following error occurred while loading numpy:\nFailed to fetch
```

Two things follow. First, core self-hosting is healthy — only `.whl` files are absent. Second, the
bundled `pyodide-lock.json` is intact and lists **357 packages** (`info: abi 2026_0, python 3.14.2`),
so the manifest needed to locate each wheel is already deployed.

Note the misleading failure mode: a missing asset surfaces as `Failed to fetch`, which reads like a
network problem even though the network is fine. Anyone debugging this should check the `content-type`
of the wheel URL first.

## 5. Python — the working escape hatches

`pyodide_js` is importable from Python, which is the entry point for all of these.

**a. `pyfetch` — HTTP from Python**

```python
from pyodide.http import pyfetch
meta = await (await pyfetch('https://pypi.org/pypi/micropip/json')).json()
```

**b. `loadPackage` with an absolute CDN URL — bypasses the broken local base**

```python
from pyodide_js import loadPackage
await loadPackage(['https://cdn.jsdelivr.net/pyodide/v314.0.7/full/numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl'])
import numpy as np
np.arange(5).sum()  # 10.0
```

Measured: numpy 2.4.6 imported and computed. The CDN hosts `v314.0.7` and its `pyodide-lock.json`
lists the *same* wheel filename as the bundled lockfile, so a name → URL mapping needs no extra
manifest, and `sha256` verification still applies.

**c. micropip bootstrapped from a PyPI wheel — the general escape hatch**

`loadPackage('micropip')` fails for the same reason as numpy, but micropip is pure Python and is also
published on PyPI, so it can be bootstrapped through `sys.path` (a wheel is a zip; `zipimport` needs
no extraction):

```python
import sys, os
from pyodide.http import pyfetch
meta = await (await pyfetch('https://pypi.org/pypi/micropip/json')).json()
wheel = [u for u in meta['urls'] if u['filename'].endswith('.whl')][0]
os.makedirs('/tmp/pkgs', exist_ok=True)
path = '/tmp/pkgs/' + wheel['filename']
with open(path, 'wb') as handle:
    handle.write(await (await pyfetch(wheel['url'])).bytes())
sys.path.insert(0, path)
import micropip
await micropip.install('tabulate')   # → 0.10.0
```

Measured working: micropip 0.11.1, `tabulate` 0.10.0 rendered a table. Notably
`await micropip.install('numpy')` also succeeded (→ 2.4.6) even though plain `loadPackage('numpy')`
fails, so micropip carries its own working package resolution. The same `sys.path` trick installs any
pure-Python wheel with no micropip at all (`packaging` 26.3, `pyyaml` 6.0.3 via CDN).

Pure-Python wheels therefore need no runner change today; only immediate *convenience* is missing.

**d. The whole stack from the CDN, driven from JS** (useful for artifact-style pages)

```js
const base = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/'
const mod = await import(base + 'pyodide.mjs')
const py = await mod.loadPyodide({ indexURL: base })
await py.loadPackage('numpy')
py.runPython('import numpy as np\nstr(round(float(np.arange(10).mean()), 3))') // '4.5'
```

Measured from `run_js`: import 113 ms, boot 2 396 ms, numpy 2 711 ms, total 4 838 ms.

## 6. Where external libraries are still blocked

Preview frames are a different story from the runners.

- `src/ui/file-view/sandbox.ts:19` — `ARTIFACT_PREVIEW_SANDBOX =
  'allow-scripts allow-forms allow-popups allow-modals'`, deliberately without `allow-same-origin`.
  The `srcdoc` document inherits the parent policy, and the comment at `:12-17` says the policy is
  inherited and cannot be made distinct.
- The production policy (`vite.config.ts`) is `script-src 'self' blob:` with no `'unsafe-eval'`.

Consequence: in a **production build**, a model-authored artifact cannot load a CDN `<script>` or
`await import('https://…')` (both are `script-src`), and cannot use `new Function` either. In **dev**
this works, because `cspPlugin()` has `apply: 'build'` and no CSP meta is injected. Expect
dev/prod divergence on exactly this feature. `connect-src` already permits `https:`, so `fetch` alone
is fine — it is only *code* loading that is restricted.

`PREVIEW_SANDBOX` (workspace-file preview, `src/ui/file-view/sandbox.ts:10`) keeps
`allow-same-origin`, which restores modules/fetch/workers/storage, but remote script loads remain
under `script-src 'self' blob:` in production.

If artifacts must pull CDN libraries in production, the options are to allowlist the origins in
`script-src`, or to vendor/proxy the libraries. That is a product decision, not a sandbox bug.

## 7. Runner state is persistent — both languages

`WorkerSession` keeps one warm worker per language and resets it only on timeout, fatal error,
`reset()`, or idle (`DEFAULT_IDLE_TIMEOUT_MS = 300_000`, `src/sandbox/session.ts:11`).

Measured across separate tool calls:

- JS: `globalThis.__probe_marker` written in one call was readable in the next.
- Python: `PROBE_MARKER`, a `sys` attribute, and a property set on the `pyodide_js` proxy all
  survived, with `len(sys.modules)` identical (389) — the same interpreter and module cache.

Earlier in the same session, `globalThis.dayjs` set by one call was gone later, which is consistent
with an idle reset between turns rather than a per-run worker. Note that
`phase-05-code-runners.md` still says "one fresh worker per run" for `JsRunner` (Requirements §1);
`session.ts` + `js-runner.ts` supersede that text. Worth correcting so future readers do not assume
per-run isolation.

Practical consequence: a library loaded or installed in one call is still there in the next, which is
what makes the §5 recipes cheap.

## 8. Recommended change

The runners cannot use `loadPackage(name)` at all today, and `PyodideLike`
(`src/sandbox/py-worker.ts:7-12`) does not even declare `loadPackage`, so the capability is
invisible to the harness.

**Option A — package base override (smallest diff, recommended as the product surface).**

Keep `indexURL` local so boot stays self-hosted and offline-capable, and point *packages* at the CDN.
Widening the interface is unavoidable either way:

```ts
interface PyodideLike {
  // …existing…
  version: string
  loadPackage(packages: string | string[]): Promise<void>
}
```

```ts
const PACKAGE_BASE = import.meta.env.VITE_PYODIDE_PACKAGE_BASE
  ?? `https://cdn.jsdelivr.net/pyodide/v${pyodide.version}/full/`
// lockfileBaseUrl is a read-only accessor, so it has to be redefined, not assigned.
Object.defineProperty(pyodide, 'lockfileBaseUrl', { get: () => PACKAGE_BASE, configurable: true })
```

Verified: after that override, plain `loadPackage('numpy')` resolves from the CDN and imports.
Assigning the property instead of redefining throws
`TypeError: Cannot set property lockfileBaseUrl of #<Object> which has only a getter`. Cost: first
load of each package needs network; `sha256` from the bundled lockfile is still enforced.

**Option B — deploy the wheels (keeps offline determinism).** Extend `scripts/copy-pyodide.mjs` with
a configured package list, resolve `depends` from the bundled lockfile, and download those wheels
into `public/pyodide/`. numpy is ~3 MB; scipy/pandas are an order of magnitude larger, so this should
stay a curated allowlist rather than "all 357".

**Option C — document the §5c bootstrap and change nothing.** It works today and needs no runner
change; the cost is that every user re-derives it, and it silently depends on the CDN and PyPI being
reachable.

A and C compose well: A for declared `pythonPackages` on a run, C as the documented fallback.

## 9. Raw evidence

| # | Probe | Result |
|---|---|---|
| A | globals in runner worker | `fetch`/`XMLHttpRequest`/`importScripts`/`Worker`/`caches` functions; `require`, `process`, `module`, `window`, `document` undefined |
| B | `importScripts` in runner worker | TypeError: Module scripts don't support importScripts() |
| C | `import(dayjs.min.js)` | no error, namespace empty, `globalThis.dayjs` set |
| D | `fetch` CDN package.json | 200, body `{"name":"lodash","version":"4.17.21",…}` |
| E | Python env | `pyodide_js`, `pyodide` importable; `micropip` absent; python 3.14.2 |
| F | `globalThis.dayjs` after import | callable, `'2024/01/02'` |
| G | `import('lodash-es/+esm')` | named exports present, `chunk` is a function |
| H | `import('esm.sh/date-fns/format')` | `default` is a function |
| I | fetch + `Function` UMD (marked) | 35 479 bytes, `parse('# hello **world**')` → `<h1>hello <strong>world</strong></h1>` |
| J | blob classic worker + importScripts | lodash 4.17.21 in the child worker |
| P1 | `pyfetch` (python) | 200 from jsdelivr |
| P2 | `loadPackage('numpy')` | `ModuleNotFoundError`, stderr `Failed to fetch` |
| P3 | pyodide config | `pyodide_js` 314.0.7, `lockfileBaseUrl = http://localhost:5173/pyodide/` |
| P4 | `loadPackage('micropip')` | `ModuleNotFoundError`, `Failed to fetch` |
| P5 | PyPI wheel + `sys.path` | `packaging` 26.3 imports; `Version('1.2') < Version('1.10')` True |
| P6 | bundled lockfile | `abi 2026_0`, python 3.14.2, 357 packages, numpy `file_name` present |
| P7 | PyPI micropip bootstrapped | micropip 0.11.1 imports; `install('six')` delegates to `loadPackage` → fails |
| P8 | CDN reachability | `v314.0.7`, `v0.28.3`, `v0.29.0`, npm pyodide, PyPI simple → all 200 |
| P9 | localhost vs 127.0.0.1 | `localhost:5173` 200; `127.0.0.1:5173` fails (cross-origin, no CORS) |
| P10 | CDN lockfile v314.0.7 | 357 packages, numpy 2.4.6 wheel downloads (2 960 568 bytes) |
| P11 | `loadPackage([absolute URL])` | numpy 2.4.6, `np.arange(5).sum()` = 10.0 |
| P12 | local `.whl` content-type | 200 `text/html` for wheel paths (SPA fallback) |
| P13 | assign `lockfileBaseUrl` | TypeError: property has only a getter |
| P14 | micropip → `install('tabulate')` | tabulate 0.10.0 |
| P15 | `loadPackage([pyyaml URL])` | pyyaml 6.0.3 parses YAML |
| P16 | micropip → `install('numpy')` | numpy 2.4.6 |
| P17 | `defineProperty(lockfileBaseUrl)` then `loadPackage('numpy')` | loads from CDN, imports |
| P18 | local asset content-types | lock json = `application/json`, wasm = `application/wasm`, wheel = `text/html` |
| N | full CDN pyodide from `run_js` | import 113 ms, boot 2 396 ms, numpy 2 711 ms, mean 4.5 |
| S1/S2 | Python state persistence | marker + `sys` attr + JS-proxy property survive; `sys.modules` 389 both times |
| M1/M2 | JS state persistence | `globalThis` marker survives across calls |

Probe labels match `public/sandbox-lib-lab.html` for 1–9; the rest were issued ad hoc.
