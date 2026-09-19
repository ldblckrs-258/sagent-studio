import type { FromWorker, ToWorker } from './protocol'

interface WorkerCtx {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent) => void) | null
}

const ctx = self as unknown as WorkerCtx

let currentRunId = ''
let requestCounter = 0
const pendingFs = new Map<string, { resolve: (data: string) => void; reject: (error: Error) => void }>()
let stdoutChunks: string[] = []
let stderrChunks: string[] = []

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    const seen = new WeakSet<object>()
    const encoded = JSON.stringify(value, (_key, nested: unknown) => {
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
  const requestId = `fs-${(requestCounter += 1)}`
  return new Promise<string>((resolve, reject) => {
    pendingFs.set(requestId, { resolve, reject })
    const message: FromWorker =
      data === undefined
        ? { kind: 'fs.call', runId: currentRunId, requestId, op, path }
        : { kind: 'fs.call', runId: currentRunId, requestId, op, path, data }
    ctx.postMessage(message)
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

function postResult(result: string | null, error?: string): void {
  const message: FromWorker =
    error === undefined
      ? { kind: 'result', runId: currentRunId, stdout: stdoutChunks.join('\n'), stderr: stderrChunks.join('\n'), result }
      : { kind: 'result', runId: currentRunId, stdout: stdoutChunks.join('\n'), stderr: stderrChunks.join('\n'), result, error }
  ctx.postMessage(message)
}

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

ctx.onmessage = (event: MessageEvent) => {
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
