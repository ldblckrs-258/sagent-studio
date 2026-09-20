import { runSearch } from './search'
import { SearchRequestError } from './search-protocol'
import type { SearchWorkerOutbound, SearchWorkerRequest } from './search-protocol'

interface WorkerCtx {
  postMessage(message: unknown): void
  onmessage: ((event: MessageEvent) => void) | null
}

const ctx = self as unknown as WorkerCtx

let requestCounter = 0
const pending = new Map<string, { resolve: (data: string) => void; reject: (error: Error) => void }>()

function callFs(op: 'list' | 'read', path: string): Promise<string> {
  const requestId = `search-fs-${(requestCounter += 1)}`
  return new Promise<string>((resolve, reject) => {
    pending.set(requestId, { resolve, reject })
    const message: SearchWorkerOutbound = { kind: 'fs.call', requestId, op, path }
    ctx.postMessage(message)
  })
}

async function execute(request: SearchWorkerRequest): Promise<void> {
  try {
    const result = await runSearch(callFs, request)
    ctx.postMessage({ kind: 'search-done', result } satisfies SearchWorkerOutbound)
  } catch (error) {
    const failure: SearchWorkerOutbound = {
      kind: 'search-error',
      code: error instanceof SearchRequestError ? error.code : 'runtime_error',
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof SearchRequestError && error.hint !== undefined ? { hint: error.hint } : {}),
    }
    ctx.postMessage(failure)
  }
}

ctx.onmessage = (event: MessageEvent) => {
  const data = event.data as { kind?: unknown }
  if (typeof data !== 'object' || data === null) return

  if (data.kind === 'fs.result') {
    const requestId = (data as { requestId?: unknown }).requestId
    if (typeof requestId !== 'string') return
    const entry = pending.get(requestId)
    if (!entry) return
    pending.delete(requestId)
    entry.resolve(typeof (data as { data?: unknown }).data === 'string' ? (data as { data: string }).data : '')
    return
  }

  if (data.kind === 'fs.error') {
    const requestId = (data as { requestId?: unknown }).requestId
    if (typeof requestId !== 'string') return
    const entry = pending.get(requestId)
    if (!entry) return
    pending.delete(requestId)
    entry.reject(new Error((data as { message?: unknown }).message as string ?? 'The workspace call failed.'))
    return
  }

  if (data.kind === 'search') {
    void execute(data as unknown as SearchWorkerRequest)
  }
}
