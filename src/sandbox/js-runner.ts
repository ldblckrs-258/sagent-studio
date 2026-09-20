import type { WorkspaceApi } from '../tools/types'
import { WorkerSession } from './session'
import type { CodeRunner, RunOptions, RunResult } from './types'
import type { WorkerFactory } from './worker-factory'

export const DEFAULT_JS_TIMEOUT_MS = 10_000

export const defaultJsWorkerFactory: WorkerFactory = () =>
  new Worker(new URL('./js-worker.ts', import.meta.url), { type: 'module' })

export interface SandboxRunnerOptions {
  workerFactory?: WorkerFactory
  workspace?: WorkspaceApi
  defaultTimeoutMs?: number
  idleTimeoutMs?: number
}

export class JsRunner implements CodeRunner {
  private readonly session: WorkerSession

  constructor(options: SandboxRunnerOptions = {}) {
    this.session = new WorkerSession({
      workerFactory: options.workerFactory ?? defaultJsWorkerFactory,
      language: 'js',
      defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_JS_TIMEOUT_MS,
      ...(options.workspace ? { workspace: options.workspace } : {}),
      ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    })
  }

  run(source: string, options: RunOptions = {}): Promise<RunResult> {
    return this.session.run(source, options)
  }

  /** Terminates the warm worker. Called when the manager rebuilds or resets. */
  dispose(): void {
    this.session.dispose()
  }
}
