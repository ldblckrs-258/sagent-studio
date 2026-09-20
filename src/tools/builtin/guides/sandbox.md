# Sandbox runs

`run_js` and `run_python` execute in a worker per language. Both return `stdout`, `stderr`, and `result`; a thrown error comes back as `runtime_error` with the message, and exceeding the time limit comes back as `timeout`.

## Lifetime and state
- Defaults: 10000 ms for JavaScript, 30000 ms for Python (settings can override both).
- In JavaScript only values assigned to `globalThis` survive into the next run; each run gets a fresh function scope, so `const`, `let`, and `function` declarations are gone. In Python the interpreter namespace is shared, so names defined earlier stay defined.
- The worker is torn down after a timeout and after 5 minutes idle, and recreated on the next call, which drops even `globalThis` state. `reset_sandbox` clears it on purpose.
- Runs are queued per language, so two calls never interleave.

## JavaScript
The body runs as an async function, so top-level `await` works and `return` surfaces the result. `console` and `fs` are parameters, not globals. There is no `require`, no `process`, and no Node `fs`; worker globals such as `fetch`, `crypto`, and `TextEncoder` are reachable.

```js
const raw = await fs.list('.')
const entries = JSON.parse(raw)
await fs.writeFile('out.txt', entries.length + ' entries')
return entries.length
```

## Python
Runs through Pyodide. Import the bridge with `import workspace`; `workspace.readFile`, `workspace.writeFile`, and `workspace.list` return awaitables backed by JavaScript, so await them. The value of the last expression becomes `result`; printing also works.

```python
import workspace, json
entries = json.loads(await workspace.list('.'))
len(entries)
```

Only the Python standard library ships with the app. `micropip`/`loadPackage` fetch wheels from a remote package base (the jsDelivr CDN unless the build overrides it), so installing a package needs network access and fails offline.

## Workspace bridge
`fs`/`workspace` reads and writes UTF-8 text inside the open workspace folder, and `list` resolves to a JSON string that must be parsed. Every call rejects when no workspace folder is open. Writes are journaled, so `checkpoint` and `restore` cover them.

## Debugging
- `timeout`: split the work into smaller runs, or raise `timeoutMs` on a custom sandbox-js tool.
- `runtime_error`: read `stderr` and the error message; a rejected `fs` call usually means no workspace folder is open or the path is outside it.
- A `ReferenceError` for something an earlier JavaScript run declared is expected: redefine it, or assign it to `globalThis` when it must outlive the run.
