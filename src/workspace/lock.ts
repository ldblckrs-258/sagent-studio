/**
 * Serializes read-modify-write cycles per workspace path. The model can emit
 * several `edit_file` calls for one file inside a single assistant step, and the
 * AI SDK runs those tool calls concurrently; without a per-path lane each call
 * reads the same revision and the last writer silently discards the others.
 *
 * Paths are canonicalized (`.` and `..` collapsed) so equivalent spellings of
 * one file share a lane. Reads take the same lane as writes, so an `edit_file`
 * and a `read_file` emitted in one step observe each other in call order.
 * `move` and `copy` are not routed through this lock today.
 *
 * The map holds only settled tails, so it cannot retain a rejected promise or
 * leak entries for paths that are no longer being written.
 */
const lanes = new Map<string, Promise<void>>()

/**
 * Tail of the workspace-wide barrier. `restore` rewrites an unknown set of
 * paths, so it cannot claim its lanes up front; instead it blocks every lane
 * claimed after it starts.
 */
let barrier: Promise<void> | null = null

function settled(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined,
  )
}

export function normalizeLockPath(path: string): string {
  const segments: string[] = []
  for (const raw of path.split('/')) {
    if (raw === '' || raw === '.') continue
    if (raw === '..') {
      segments.pop()
      continue
    }
    segments.push(raw)
  }
  return segments.join('/')
}

export function withPathLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const key = normalizeLockPath(path)
  const previous = lanes.get(key) ?? Promise.resolve()
  const gate = barrier === null ? previous : settled(Promise.all([previous, barrier]))
  const run = gate.then(task, task)
  const tail = settled(run)
  lanes.set(key, tail)
  void tail.then(() => {
    if (lanes.get(key) === tail) lanes.delete(key)
  })
  return run
}

/**
 * Runs a task that may touch any path with no other workspace task in flight.
 * The barrier is claimed synchronously, so a per-path task started later in the
 * same step queues behind it.
 */
export function withWorkspaceLock<T>(task: () => Promise<T>): Promise<T> {
  const pending = [...lanes.values()]
  const gate = settled(Promise.all(barrier === null ? pending : [barrier, ...pending]))
  const run = gate.then(task, task)
  const tail = settled(run)
  barrier = tail
  void tail.then(() => {
    if (barrier === tail) barrier = null
  })
  return run
}

/** Test hook: drop any recorded lanes between cases. */
export function resetPathLocks(): void {
  lanes.clear()
  barrier = null
}
