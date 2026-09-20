import type { FromWorker, ToWorker } from './protocol'

interface WorkerCtx {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent) => void) | null
  addEventListener(type: string, listener: (event: Event) => void): void
}

interface PyodideLike {
  runPythonAsync(code: string): Promise<unknown>
  registerJsModule(name: string, module: unknown): void
  setStdout(options: { batched: (text: string) => void }): void
  setStderr(options: { batched: (text: string) => void }): void
}

const ctx = self as unknown as WorkerCtx

let port: MessagePort | null = null
let pyodidePromise: Promise<PyodideLike> | null = null
let currentRunId = ''
let requestCounter = 0
const pendingFs = new Map<string, { resolve: (data: string) => void; reject: (error: Error) => void }>()
let stdoutChunks: string[] = []
let stderrChunks: string[] = []

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function pyodideIndexUrl(): string {
  const base = import.meta.env.BASE_URL
  const withSlash = base.endsWith('/') ? base : `${base}/`
  return new URL(`${withSlash}pyodide/`, self.location.origin).href
}

async function loadPyodideOnce(): Promise<PyodideLike> {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      const indexURL = pyodideIndexUrl()
      // The URL must be absolute: Vite wraps non-literal dynamic imports in
      // __vite__injectQuery, which appends `?import` to values starting with
      // "/" and routes the public asset through the dev transform middleware.
      const moduleUrl = `${indexURL}pyodide.mjs`
      const mod = (await import(/* @vite-ignore */ moduleUrl)) as {
        loadPyodide(options: { indexURL: string }): Promise<PyodideLike>
      }
      return mod.loadPyodide({ indexURL })
    })().catch((error: unknown) => {
      pyodidePromise = null
      throw error
    })
  }
  return pyodidePromise
}

function callFs(op: 'read' | 'write' | 'list', path: string, data?: string): Promise<string> {
  if (!port) return Promise.reject(new Error('The sandbox port is not connected.'))
  const requestId = `fs-${(requestCounter += 1)}`
  return new Promise<string>((resolve, reject) => {
    pendingFs.set(requestId, { resolve, reject })
    const message: FromWorker =
      data === undefined
        ? { kind: 'fs.call', runId: currentRunId, requestId, op, path }
        : { kind: 'fs.call', runId: currentRunId, requestId, op, path, data }
    port?.postMessage(message)
  })
}

function postFatal(message: string): void {
  if (!port) return
  port.postMessage({ kind: 'fatal', message } satisfies FromWorker)
}

function describeEvent(event: Event): string {
  const candidate = event as { error?: unknown; reason?: unknown }
  const error = candidate.error ?? candidate.reason
  return error === undefined ? 'The sandbox worker failed.' : describe(error)
}

ctx.addEventListener('error', (event) => postFatal(describeEvent(event)))
ctx.addEventListener('unhandledrejection', (event) => postFatal(describeEvent(event)))

function postResult(result: string | null, error?: string, fatal?: boolean): void {
  if (!port) return
  const message = {
    kind: 'result' as const,
    runId: currentRunId,
    stdout: stdoutChunks.join('\n'),
    stderr: stderrChunks.join('\n'),
    result,
    ...(error === undefined ? {} : { error }),
    ...(fatal === undefined ? {} : { fatal }),
  }
  port.postMessage(message)
}

async function handleRun(source: string, runId: string): Promise<void> {
  currentRunId = runId
  stdoutChunks = []
  stderrChunks = []
  let pyodide: PyodideLike
  try {
    pyodide = await loadPyodideOnce()
  } catch (error) {
    postResult(null, describe(error), true)
    return
  }
  try {
    pyodide.setStdout({ batched: (text) => stdoutChunks.push(text) })
    pyodide.setStderr({ batched: (text) => stderrChunks.push(text) })
    pyodide.registerJsModule('workspace', {
      readFile: (path: string) => callFs('read', path),
      writeFile: (path: string, data: string) => callFs('write', path, data),
      list: (path: string) => callFs('list', path),
    })
    const value = await pyodide.runPythonAsync(source)
    postResult(value === undefined || value === null ? null : String(value))
  } catch (error) {
    postResult(null, describe(error))
  }
}

function onPortMessage(event: MessageEvent): void {
  const data = event.data as ToWorker | Record<string, unknown>
  if (typeof data !== 'object' || data === null) return
  const kind = (data as { kind?: unknown }).kind

  if (kind === 'fs.result') {
    const requestId = (data as { requestId?: unknown }).requestId
    if (typeof requestId !== 'string') return
    const entry = pendingFs.get(requestId)
    if (!entry) return
    pendingFs.delete(requestId)
    entry.resolve((data as { data?: string }).data ?? '')
    return
  }

  if (kind === 'fs.error') {
    const requestId = (data as { requestId?: unknown }).requestId
    if (typeof requestId !== 'string') return
    const entry = pendingFs.get(requestId)
    if (!entry) return
    pendingFs.delete(requestId)
    entry.reject(new Error((data as { message?: string }).message ?? 'workspace call failed'))
    return
  }

  if (kind === 'run') {
    const runId = (data as { runId?: unknown }).runId
    const source = (data as { source?: unknown }).source
    if (typeof runId !== 'string' || typeof source !== 'string') return
    void handleRun(source, runId)
  }
}

ctx.onmessage = (event: MessageEvent) => {
  const data = event.data as { kind?: unknown } | null
  if (!data || data.kind !== 'init') return
  const transferred = event.ports[0]
  if (!transferred) return
  port = transferred
  port.onmessage = onPortMessage
  port.start()
}
