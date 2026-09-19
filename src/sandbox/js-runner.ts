import type { WorkspaceApi } from '../tools/types'
import { attachFsHandler } from './fs-bridge'
import type { PendingFs } from './fs-bridge'
import { SandboxTimeoutError, parseInbound, truncateOutput } from './protocol'
import type { ToWorker } from './protocol'
import type { CodeRunner, RunOptions, RunResult } from './types'
import type { WorkerFactory } from './worker-factory'

export const DEFAULT_JS_TIMEOUT_MS = 10_000

export const defaultJsWorkerFactory: WorkerFactory = () =>
  new Worker(new URL('./js-worker.ts', import.meta.url), { type: 'module' })

export interface SandboxRunnerOptions {
  workerFactory?: WorkerFactory
  workspace?: WorkspaceApi
  defaultTimeoutMs?: number
}

export class JsRunner implements CodeRunner {
  private readonly workerFactory: WorkerFactory
  private readonly workspace?: WorkspaceApi
  private readonly defaultTimeoutMs: number
  private runCounter = 0

  constructor(options: SandboxRunnerOptions = {}) {
    this.workerFactory = options.workerFactory ?? defaultJsWorkerFactory
    this.workspace = options.workspace
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_JS_TIMEOUT_MS
  }

  run(source: string, options: RunOptions = {}): Promise<RunResult> {
    return this.runOnce(source, options.timeoutMs ?? this.defaultTimeoutMs)
  }

  private runOnce(source: string, timeoutMs: number): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      const runId = `js-${(this.runCounter += 1)}`
      const worker = this.workerFactory()
      const pendingFs = new Set<PendingFs>()
      const state: { timer: ReturnType<typeof setTimeout> | undefined } = { timer: undefined }
      let disposed = false
      let settled = false

      const safePost = (message: ToWorker): void => {
        if (!disposed) worker.postMessage(message)
      }

      const settle = (outcome: () => void): void => {
        if (settled) return
        settled = true
        if (state.timer) clearTimeout(state.timer)
        disposed = true
        worker.removeEventListener('message', onMessage)
        worker.terminate()
        outcome()
      }

      const onMessage = (event: MessageEvent): void => {
        const message = parseInbound(event.data)
        if (!message || message.runId !== runId) return
        if (message.kind === 'fs.call') {
          attachFsHandler(this.workspace, message, pendingFs, safePost)
          return
        }
        settle(() =>
          resolve({
            stdout: truncateOutput(message.stdout),
            stderr: truncateOutput(message.stderr),
            result: message.result,
            ...(message.error !== undefined ? { error: message.error } : {}),
          }),
        )
      }

      worker.addEventListener('message', onMessage)

      state.timer = setTimeout(() => {
        for (const entry of pendingFs) entry.cancel(new SandboxTimeoutError())
        pendingFs.clear()
        settle(() => reject(new SandboxTimeoutError()))
      }, timeoutMs)

      safePost({ kind: 'run', runId, language: 'js', source })
    })
  }
}
