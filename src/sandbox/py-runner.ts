import type { WorkspaceApi } from '../tools/types'
import { attachFsHandler } from './fs-bridge'
import type { PendingFs } from './fs-bridge'
import { SandboxTimeoutError, parseInbound, truncateOutput } from './protocol'
import type { ToWorker } from './protocol'
import type { CodeRunner, RunOptions, RunResult } from './types'
import type { WorkerFactory } from './worker-factory'

export const DEFAULT_PY_TIMEOUT_MS = 30_000

export const defaultPyWorkerFactory: WorkerFactory = () =>
  new Worker(new URL('./py-worker.ts', import.meta.url), { type: 'module' })

export interface PyRunnerOptions {
  workerFactory?: WorkerFactory
  workspace?: WorkspaceApi
  defaultTimeoutMs?: number
}

interface RunEntry {
  runId: string
  timer: ReturnType<typeof setTimeout> | undefined
  pendingFs: Set<PendingFs>
  settled: boolean
  resolve(result: RunResult): void
  reject(error: Error): void
}

export class PyRunner implements CodeRunner {
  private readonly workerFactory: WorkerFactory
  private readonly workspace?: WorkspaceApi
  private readonly defaultTimeoutMs: number
  private worker: Worker | null = null
  private port: MessagePort | null = null
  private readonly runs = new Map<string, RunEntry>()
  private runCounter = 0
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: PyRunnerOptions = {}) {
    this.workerFactory = options.workerFactory ?? defaultPyWorkerFactory
    this.workspace = options.workspace
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_PY_TIMEOUT_MS
  }

  // The Python worker keeps per-run state in module scope, so runs are
  // serialized: a second run starts only after the first settles.
  run(source: string, options: RunOptions = {}): Promise<RunResult> {
    const execute = () => this.runOne(source, options)
    const result = this.queue.then(execute, execute)
    this.queue = result.catch(() => undefined)
    return result
  }

  private runOne(source: string, options: RunOptions): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      const port = this.ensurePort()
      const runId = `py-${(this.runCounter += 1)}`
      const entry: RunEntry = {
        runId,
        timer: undefined,
        pendingFs: new Set(),
        settled: false,
        resolve,
        reject,
      }

      entry.timer = setTimeout(() => {
        for (const pending of entry.pendingFs) pending.cancel(new SandboxTimeoutError())
        entry.pendingFs.clear()
        this.finish(entry, true)
        reject(new SandboxTimeoutError())
      }, options.timeoutMs ?? this.defaultTimeoutMs)

      this.runs.set(runId, entry)
      const message: ToWorker = { kind: 'run', runId, language: 'py', source }
      port.postMessage(message)
    })
  }

  private ensurePort(): MessagePort {
    if (this.worker && this.port) return this.port
    const worker = this.workerFactory()
    const channel = new MessageChannel()
    const port = channel.port1
    port.onmessage = (event: MessageEvent) => this.dispatch(event.data)
    port.start()
    worker.postMessage({ kind: 'init' }, [channel.port2])
    this.worker = worker
    this.port = port
    return port
  }

  private finish(entry: RunEntry, respawn: boolean): void {
    if (entry.settled) return
    entry.settled = true
    if (entry.timer) clearTimeout(entry.timer)
    this.runs.delete(entry.runId)
    if (respawn) this.terminateAndRespawn()
  }

  private dispatch(raw: unknown): void {
    const fatal =
      typeof raw === 'object' && raw !== null && (raw as { fatal?: unknown }).fatal === true
    const message = parseInbound(raw)
    if (!message) return
    const entry = this.runs.get(message.runId)
    if (!entry || entry.settled) return

    if (message.kind === 'fs.call') {
      attachFsHandler(this.workspace, message, entry.pendingFs, (outbound) => {
        if (!entry.settled) this.port?.postMessage(outbound)
      })
      return
    }

    const result: RunResult = {
      stdout: truncateOutput(message.stdout),
      stderr: truncateOutput(message.stderr),
      result: message.result,
      ...(message.error !== undefined ? { error: message.error } : {}),
    }
    this.finish(entry, fatal)
    entry.resolve(result)
  }

  private terminateAndRespawn(): void {
    for (const entry of this.runs.values()) {
      for (const pending of entry.pendingFs) pending.cancel(new SandboxTimeoutError())
      entry.pendingFs.clear()
      if (!entry.settled) {
        entry.settled = true
        if (entry.timer) clearTimeout(entry.timer)
        entry.reject(new SandboxTimeoutError())
      }
    }
    this.runs.clear()
    if (this.port) {
      this.port.onmessage = null
      this.port.close()
    }
    this.worker?.terminate()
    this.worker = null
    this.port = null
  }
}
