import type { FromWorker, ToWorker } from './protocol'

interface WorkerCtx {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent) => void) | null
  addEventListener(type: string, listener: (event: Event) => void): void
}

const ctx = self as unknown as WorkerCtx

let port: MessagePort | null = null
let currentRunId = ''
let requestCounter = 0
const pendingFs = new Map<string, { resolve: (data: string) => void; reject: (error: Error) => void }>()
let stdoutChunks: string[] = []
let stderrChunks: string[] = []

interface HarnessSnapshot {
  stringify: typeof JSON.stringify
  post: (message: unknown) => void
}

// Snapshot the reporting intrinsics at init so a prior run cannot poison the
// next run's result reporting through `globalThis`.
let snapshot: HarnessSnapshot | null = null

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  const encode = snapshot?.stringify ?? JSON.stringify
  try {
    const seen = new WeakSet<object>()
    const encoded = encode(value, (_key, nested: unknown) => {
      if (typeof nested === 'object' && nested !== null) {
        if (seen.has(nested)) return '[Circular]'
        seen.add(nested)
      }
      return nested
    })
    return encoded ?? String(value)
  } catch {
    return String(value)
  }
}

function formatArgs(args: unknown[]): string {
  return args.map((arg) => (typeof arg === 'string' ? arg : stringify(arg))).join(' ')
}

const consoleShim = {
  log: (...args: unknown[]) => stdoutChunks.push(formatArgs(args)),
  info: (...args: unknown[]) => stdoutChunks.push(formatArgs(args)),
  debug: (...args: unknown[]) => stdoutChunks.push(formatArgs(args)),
  warn: (...args: unknown[]) => stderrChunks.push(formatArgs(args)),
  error: (...args: unknown[]) => stderrChunks.push(formatArgs(args)),
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

const fsShim = {
  readFile: (path: string) => callFs('read', path),
  writeFile: (path: string, data: string) => callFs('write', path, data),
  list: (path: string) => callFs('list', path),
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function postResult(result: string | null, error?: string, fatal?: boolean): void {
  if (!snapshot) return
  const message: FromWorker = {
    kind: 'result',
    runId: currentRunId,
    stdout: stdoutChunks.join('\n'),
    stderr: stderrChunks.join('\n'),
    result,
    ...(error === undefined ? {} : { error }),
    ...(fatal === undefined ? {} : { fatal }),
  }
  snapshot.post(message)
}

function postFatal(message: string): void {
  if (!snapshot) return
  snapshot.post({ kind: 'fatal', message } satisfies FromWorker)
}

function describeEvent(event: Event): string {
  const candidate = event as { error?: unknown; reason?: unknown }
  const error = candidate.error ?? candidate.reason
  return error === undefined ? 'The sandbox worker failed.' : describe(error)
}

ctx.addEventListener('error', (event) => postFatal(describeEvent(event)))
ctx.addEventListener('unhandledrejection', (event) => postFatal(describeEvent(event)))

type AsyncFn = (...args: unknown[]) => Promise<unknown>
const AsyncFunctionConstructor = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => AsyncFn

async function handleRun(source: string, runId: string): Promise<void> {
  currentRunId = runId
  stdoutChunks = []
  stderrChunks = []
  try {
    const fn = new AsyncFunctionConstructor('console', 'fs', source)
    const value = await fn(consoleShim, fsShim)
    postResult(value === undefined ? null : stringify(value))
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
  snapshot = { stringify: JSON.stringify.bind(JSON), post: port.postMessage.bind(port) }
}
