import { executeFsCall } from '../sandbox/fs-bridge'
import type { FsCall } from '../sandbox/fs-bridge'
import type { WorkerFactory } from '../sandbox/worker-factory'
import type {
  WorkspaceApi,
  WorkspaceSearchOptions,
  WorkspaceSearchResult,
} from '../tools/types'
import { runSearch } from './search'
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_FILES_SCANNED,
  DEFAULT_MAX_SEARCH_RESULTS,
  MAX_SEARCH_RESULTS,
} from './search'
import { SEARCH_TIMEOUT_MS, SearchRequestError } from './search-protocol'
import type { SearchWorkerOutbound, SearchWorkerRequest } from './search-protocol'

export const defaultSearchWorkerFactory: WorkerFactory = () =>
  new Worker(new URL('./search-worker.ts', import.meta.url), { type: 'module' })

export interface SearchRunner {
  search(options: WorkspaceSearchOptions): Promise<WorkspaceSearchResult>
  dispose(): void
}

export interface SearchRunnerOptions {
  workerFactory?: WorkerFactory
  workspace?: WorkspaceApi
  timeoutMs?: number
}

export function toSearchRequest(options: WorkspaceSearchOptions): SearchWorkerRequest {
  const requested = options.maxResults ?? DEFAULT_MAX_SEARCH_RESULTS
  return {
    kind: 'search',
    pattern: options.pattern,
    flags: options.ignoreCase ? 'i' : '',
    rootPath: options.path ?? '',
    maxResults: Math.max(1, Math.min(requested, MAX_SEARCH_RESULTS)),
    maxFilesScanned: options.maxFilesScanned ?? DEFAULT_MAX_FILES_SCANNED,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    ...(options.excludedDirs === undefined ? {} : { excludedDirs: options.excludedDirs }),
  }
}

export function createSearchRunner(options: SearchRunnerOptions = {}): SearchRunner {
  const workerFactory = options.workerFactory ?? defaultSearchWorkerFactory
  const workspace = options.workspace
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS
  let worker: Worker | null = null

  const resetWorker = (active: Worker): void => {
    active.terminate()
    if (worker === active) worker = null
  }

  return {
    search(searchOptions) {
      const request = toSearchRequest(searchOptions)
      return new Promise<WorkspaceSearchResult>((resolve, reject) => {
        const active = worker ?? workerFactory()
        worker = active
        let settled = false
        const timer: { handle?: ReturnType<typeof setTimeout> } = {}

        function finish(outcome: () => void): void {
          if (settled) return
          settled = true
          if (timer.handle) clearTimeout(timer.handle)
          active.removeEventListener('message', onMessage)
          active.removeEventListener('error', onError)
          outcome()
        }

        function onMessage(event: MessageEvent): void {
          const data = event.data as { kind?: unknown }
          if (typeof data !== 'object' || data === null) return

          if (data.kind === 'fs.call') {
            const call = data as Extract<SearchWorkerOutbound, { kind: 'fs.call' }>
            const handle: FsCall = {
              kind: 'fs.call',
              runId: 'search',
              requestId: call.requestId,
              op: call.op,
              path: call.path,
            }
            executeFsCall(workspace, handle).then(
              (value) => {
                if (!settled) {
                  active.postMessage({
                    kind: 'fs.result',
                    requestId: call.requestId,
                    ok: true,
                    data: value,
                  })
                }
              },
              (error: unknown) => {
                if (!settled) {
                  active.postMessage({
                    kind: 'fs.error',
                    requestId: call.requestId,
                    ok: false,
                    message: error instanceof Error ? error.message : String(error),
                  })
                }
              },
            )
            return
          }

          if (data.kind === 'search-done') {
            const result = (data as Extract<SearchWorkerOutbound, { kind: 'search-done' }>).result
            finish(() => resolve(result))
            return
          }

          if (data.kind === 'search-error') {
            const failure = data as Extract<SearchWorkerOutbound, { kind: 'search-error' }>
            finish(() =>
              reject(
                new SearchRequestError(failure.code, failure.message, {
                  ...(failure.hint === undefined ? {} : { hint: failure.hint }),
                }),
              ),
            )
          }
        }

        const onError = (): void => {
          resetWorker(active)
          finish(() => reject(new SearchRequestError('runtime_error', 'The search worker failed.')))
        }

        timer.handle = setTimeout(() => {
          resetWorker(active)
          finish(() =>
            reject(
              new SearchRequestError('timeout', `The search exceeded ${timeoutMs}ms.`, {
                hint: 'Narrow the pattern or the searched path and retry.',
              }),
            ),
          )
        }, timeoutMs)

        active.addEventListener('message', onMessage)
        active.addEventListener('error', onError)
        active.postMessage(request)
      })
    },

    dispose() {
      worker?.terminate()
      worker = null
    },
  }
}

export function createInlineSearchRunner(
  workspace: Pick<WorkspaceApi, 'list' | 'readFile'>,
): SearchRunner {
  return {
    search: (options) =>
      runSearch(
        (op, path) =>
          op === 'read'
            ? workspace.readFile(path)
            : workspace.list(path).then((entries) => JSON.stringify(entries)),
        toSearchRequest(options),
      ),
    dispose() {},
  }
}
