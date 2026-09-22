import { clear, hydrate } from './index-cache'

export interface StartRagIndexOptions {
  onProgress?: (progress: { done: number; total: number }) => void
  signal?: AbortSignal
}

function combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal {
  if (a && b) return AbortSignal.any([a, b])
  return (a ?? b) as AbortSignal
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * The single place the vector index is wired to the session lifecycle. Owns an
 * AbortController and returns a `stop()` that aborts the hydrate **before**
 * clearing the index, so an in-flight hydrate can never repopulate it after
 * shutdown. A second `stop()` is a no-op.
 */
export async function startRagIndex(options: StartRagIndexOptions = {}): Promise<() => void> {
  const controller = new AbortController()
  const signal = combineSignals(options.signal, controller.signal)
  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    controller.abort()
    clear()
  }

  try {
    await hydrate({ onProgress: options.onProgress, signal })
  } catch (error) {
    // A caller-driven abort (unmount) is not a failure; hand back a stop so the
    // cleanup path stays uniform. Any other error propagates to the caller.
    if (options.signal?.aborted || isAbortError(error)) return stop
    throw error
  }
  return stop
}
