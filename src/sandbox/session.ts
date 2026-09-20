import type { WorkspaceApi } from '../tools/types'
import { attachFsHandler } from './fs-bridge'
import type { PendingFs, WorkspaceSource } from './fs-bridge'
import { SandboxTimeoutError, parseInbound, truncateOutput } from './protocol'
import type { ToWorker } from './protocol'
import type { RunOptions, RunResult } from './types'
import type { WorkerFactory } from './worker-factory'

export const DEFAULT_IDLE_TIMEOUT_MS = 300_000

export interface WorkerSessionOptions {
  workerFactory: WorkerFactory
  language: 'js' | 'py'
  defaultTimeoutMs: number
  workspace?: WorkspaceApi
  /** Resolved per `fs.call`, so a folder granted after the session opened still works. */
  getWorkspace?: () => WorkspaceApi | undefined
  idleTimeoutMs?: number
}

interface RunEntry {
  runId: string
  timer: ReturnType<typeof setTimeout> | undefined
  pendingFs: Set<PendingFs>
  settled: boolean
  resolve(result: RunResult): void
  reject(error: Error): void
}

export class WorkerSession {
  private readonly workerFactory: WorkerFactory
  private readonly language: 'js' | 'py'
  private readonly defaultTimeoutMs: number
  private readonly workspace: WorkspaceSource
  private readonly idleTimeoutMs: number
  private worker: Worker | null = null
  private port: MessagePort | null = null
  private readonly runs = new Map<string, RunEntry>()
  private runCounter = 0
  private queue: Promise<unknown> = Promise.resolve()
  private idleTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: WorkerSessionOptions) {
    this.workerFactory = options.workerFactory
    this.language = options.language
    this.defaultTimeoutMs = options.defaultTimeoutMs
    this.workspace = options.getWorkspace ?? options.workspace
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  }

  /** Terminates the warm worker and rejects every unsettled run. No respawn. */
  reset(): void {
    this.clearIdle()
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

  dispose(): void {
    this.reset()
  }

  run(source: string, options: RunOptions = {}): Promise<RunResult> {
    const execute = () => this.runOne(source, options)
    const result = this.queue.then(execute, execute)
    this.queue = result.catch(() => undefined)
    return result
  }

  private runOne(source: string, options: RunOptions): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      const port = this.ensurePort()
      const runId = `${this.language}-${(this.runCounter += 1)}`
      const entry: RunEntry = {
        runId,
        timer: undefined,
        pendingFs: new Set(),
        settled: false,
        resolve,
        reject,
      }

      if (!port) {
        entry.settled = true
        reject(new SandboxTimeoutError('The sandbox session is not available.'))
        return
      }

      entry.timer = setTimeout(() => {
        for (const pending of entry.pendingFs) pending.cancel(new SandboxTimeoutError())
        entry.pendingFs.clear()
        this.finish(entry, true)
        reject(new SandboxTimeoutError())
      }, options.timeoutMs ?? this.defaultTimeoutMs)

      this.runs.set(runId, entry)
      this.rearmIdle()
      const message: ToWorker = { kind: 'run', runId, language: this.language, source }
      port.postMessage(message)
    })
  }

  private ensurePort(): MessagePort | null {
    if (this.worker && this.port) return this.port
    let worker: Worker
    try {
      worker = this.workerFactory()
    } catch {
      return null
    }
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
    if (respawn) this.reset()
  }

  private dispatch(raw: unknown): void {
    this.rearmIdle()
    const kind = (raw as { kind?: unknown } | null)?.kind
    if (kind === 'fatal') {
      this.reset()
      return
    }
    const fatal = typeof raw === 'object' && raw !== null && (raw as { fatal?: unknown }).fatal === true
    const message = parseInbound(raw)
    if (!message || message.kind === 'fatal') return
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

  private rearmIdle(): void {
    this.clearIdle()
    if (this.idleTimeoutMs <= 0) return
    this.idleTimer = setTimeout(() => this.reset(), this.idleTimeoutMs)
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }
}
