export interface WriteQueue {
  enqueue(task: () => Promise<void>): Promise<void>
  drain(): Promise<void>
  reset(): void
}

export function createWriteQueue(): WriteQueue {
  let chain: Promise<unknown> = Promise.resolve()
  return {
    enqueue(task) {
      const run = chain.then(task, task)
      chain = run.catch(() => undefined)
      return run
    },
    async drain() {
      await chain.catch(() => undefined)
    },
    reset() {
      chain = Promise.resolve()
    },
  }
}
