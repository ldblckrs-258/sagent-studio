/**
 * Serializes read-modify-write cycles per workspace path. The model can emit
 * several `edit_file` calls for one file inside a single assistant step, and the
 * AI SDK runs those tool calls concurrently; without a per-path lane each call
 * reads the same revision and the last writer silently discards the others.
 *
 * Paths are canonicalized (`.` and `..` collapsed) so equivalent spellings of
 * one file share a lane. `move`, `copy`, and sandbox `fs.writeFile` are not
 * routed through this lock today.
 *
 * The map holds only settled tails, so it cannot retain a rejected promise or
 * leak entries for paths that are no longer being written.
 */
const lanes = new Map<string, Promise<void>>()

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
  const run = previous.then(task, task)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  lanes.set(key, tail)
  void tail.then(() => {
    if (lanes.get(key) === tail) lanes.delete(key)
  })
  return run
}

/** Test hook: drop any recorded lanes between cases. */
export function resetPathLocks(): void {
  lanes.clear()
}
