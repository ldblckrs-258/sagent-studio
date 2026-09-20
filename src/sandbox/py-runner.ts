import type { WorkspaceApi } from '../tools/types'
import { WorkerSession } from './session'
import type { CodeRunner, RunOptions, RunResult } from './types'
import type { WorkerFactory } from './worker-factory'

export const DEFAULT_PY_TIMEOUT_MS = 30_000

export const defaultPyWorkerFactory: WorkerFactory = () =>
  new Worker(new URL('./py-worker.ts', import.meta.url), { type: 'module' })

export interface PyRunnerOptions {
  workerFactory?: WorkerFactory
  workspace?: WorkspaceApi
  /** Resolved per workspace call; preferred over `workspace` when the folder may open later. */
  getWorkspace?: () => WorkspaceApi | undefined
  defaultTimeoutMs?: number
  idleTimeoutMs?: number
}

export class PyRunner implements CodeRunner {
  private readonly session: WorkerSession

  constructor(options: PyRunnerOptions = {}) {
    this.session = new WorkerSession({
      workerFactory: options.workerFactory ?? defaultPyWorkerFactory,
      language: 'py',
      defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_PY_TIMEOUT_MS,
      ...(options.getWorkspace ? { getWorkspace: options.getWorkspace } : {}),
      ...(options.getWorkspace === undefined && options.workspace
        ? { workspace: options.workspace }
        : {}),
      ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    })
  }

  run(source: string, options: RunOptions = {}): Promise<RunResult> {
    return this.session.run(source, options)
  }

  /** Terminates the warm worker and closes its port. No respawn. */
  dispose(): void {
    this.session.dispose()
  }
}
