# Probe 02 — Verification of the `packageBaseUrl` fix

Status: done (2026-09-20)
Scope: `src/sandbox/py-worker.ts` after the fix, plus a regression pass over the JS routes
from probe 01.
Question: does `loadPackage` actually work now, does the JS runner still reach the network,
and which claims in probe 01 survive re-testing?

Method note: `run_js` and `run_python` **are** the product runners, not an external harness.
`self.constructor.name` is `DedicatedWorkerGlobalScope` and
`self.location.href` is `http://localhost:5173/src/sandbox/js-worker.ts?worker_file&type=module`;
`run_python` reports `pyodide_js.version === '314.0.7'`, CPython 3.14.2, and a registered
`workspace` module. So every measurement below is the real runner in the dev server, which
makes it evidence about the product rather than about a lab approximation.

## 1. The fix is live — direct assertion

`pyodide.lockfileBaseUrl` returns `API.config.packageCacheDir ?? API.config.packageBaseUrl`,
i.e. exactly the value `PackageManager` captured when `loadPyodide()` built the API:

```
lockfileBaseUrl = https://cdn.jsdelivr.net/pyodide/v314.0.7/full/
```

The URL is built from `mod.version`, so this also proves `pyodide.mjs` exports `version`
(`export{dt as loadPyodide,U as version}` with `var Y="314.0.7"`). If that export were ever
dropped, the base URL would silently become `.../vundefined/full/`, so the assertion is worth
keeping as a smoke test.

## 2. Negative control — the pre-fix failure reproduced

| request | status | content-type | bytes | first bytes |
|---|---|---|---|---|
| `/pyodide/numpy-2.4.6-...whl` | 200 | `text/html` | 636 | `<!do` |
| `/pyodide/pyodide-lock.json` | 200 | `application/json` | 119077 | `{"in` |
| `/pyodide/pyodide.mjs` | 200 | `text/javascript` | 17931 | `var ` |
| CDN `.../v314.0.7/full/numpy-...whl` | 200 | `application/wasm` | 2960568 | `PK..` |

The local core still serves correctly, and the wheel path still returns the dev server's
`index.html` fallback (Vite's html-fallback middleware accepts `Accept: */*`, which is what
`fetch` sends). That is the exact pre-fix failure, so the diagnosis in probe 01 §4 holds.

## 3. Python — end to end

```
await pyodide_js.loadPackage(['numpy', 'pyyaml'])   # 0.35s
numpy 2.4.6      arange(100).sum() = 4950     std([1,2,3,4]) = 1.118034   dtype int32
pyyaml 6.0.3     safe_load('a: [1, 2, 3]') = {'a': [1, 2, 3]}
```

Transitive resolution against the CDN works too:

```
await pyodide_js.loadPackage('pandas')              # 0.63s
stdout: Loading pandas, python-dateutil, pytz, six
        Loaded pandas, python-dateutil, pytz, six
pandas 3.0.2     shape (3, 2)     sum = {'a': 6.0, 'b': 15.0}     numpy 2.4.6
```

`checkIntegrity` defaults to true, so these loads also confirm that the CDN bytes match the
lockfile `sha256` — the integrity path that would have caught a core/wheel build mismatch.
(Note: the CDN `content-length` header and the actual body length disagreed, 2929885 vs
2960568. The integrity check passing is the authoritative signal; the header is unreliable.)

## 4. General escape hatch: micropip + PyPI — now verified

Probe 01 asserted this and was later retracted because the harness's `fetch` does not expose
`access-control-allow-origin` faithfully (it reports `null` even for `api.github.com`, which
always sends `*`). Re-tested inside the real runner, where the fetch happens in Pyodide:

```
await pyodide_js.loadPackage('micropip')            # 0.11.1
await micropip.install('tabulate')                  # 0.66s, from PyPI
tabulate.tabulate([[1, 2], [3, 4]], headers=['x', 'y'])
```

So arbitrary PyPI packages work. The earlier retraction was a measurement artifact, not a
real CORS problem. `micropip` itself arriving from the CDN is expected: `e.cdnUrl` in
`loadPyodide` is set from `packageBaseUrl`.

## 5. Error surface is now sane

```
await pyodide_js.loadPackage('definitely-not-a-package')
→ JsException: Error: No known package with name 'definitely-not-a-package'
```

Pre-fix this path produced an HTML-parse failure because the dev server answered the wheel
request with `index.html`. The message is now actionable.

One cosmetic issue: `loadPackage` writes `Loading ... / Loaded ...` to the run's stdout, so
those lines appear mixed into program output. Not a correctness problem, but a model reading
stdout will see them.

## 6. JS — regression pass, all still working

| route | result |
|---|---|
| `import('https://cdn.jsdelivr.net/npm/lodash-es@4.17.23/+esm')` | ok, 305 exports, `chunk([[1,2],[3,4]],2)` → `[[1,2],[3,4]]` |
| UMD: `fetch(text)` + `new Function` | ok, dayjs 7161 bytes, `format('2026-09-19')` → `2026-09-19` |
| `typeof importScripts` | `"function"` |
| `importScripts(...)` **called** | throws `TypeError: Module scripts don't support importScripts()` |
| blob classic worker from inside the worker | ok, `importScripts` works there and CDN HEAD → 200 |

Two corrections to probe 01 §3: `typeof importScripts` is `"function"` even in a module
worker, so a `typeof` probe gives a false positive — the call is what fails. And a blob
classic worker spawned inside the runner has network access too, which makes it a viable
route when a library genuinely needs `importScripts`.

Also observed: `import.meta` inside `run_js` user code throws
`SyntaxError: Cannot use 'import.meta' outside a module`. User code is evaluated through
`new AsyncFunction(...)` (a classic function body) inside a module worker, so `import.meta`
is unavailable even though dynamic `import()` works. Worth documenting for model-authored code.

## 7. Not verified here

- **Production build.** All evidence above is the Vite dev server. In a built app the runner
  chunks are same-origin assets with no document CSP, so the boot-time CDN import and
  `fetch` should behave identically, but that is inference from spec plus the `vite.config.ts`
  comment, not a measurement. A `vite preview` pass is the way to close it.
- **The `VITE_PYODIDE_PACKAGE_BASE` override branch.** No env var was set, so only the
  default (CDN) branch was exercised.
- **esm.sh.** Not re-tested this round; only jsDelivr was.
- **Offline behaviour.** Core boots locally, but every package now requires the CDN. If the
  app is expected to run packages with no network, curated wheels must be vendored into
  `public/pyodide/` (option B from probe 01 §8) — the npm `pyodide` package does not ship
  wheels, so that requires a download step at build time.
