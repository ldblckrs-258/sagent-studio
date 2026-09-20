import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceApi } from '../tools/types'
import { createSearchRunner } from './search-runner'
import { SEARCH_TIMEOUT_MS } from './search-protocol'

class FakeWorker {
  posted: unknown[] = []
  terminated = false
  onPost?: (message: unknown, worker: FakeWorker) => void
  private listeners = new Map<string, Set<(event: unknown) => void>>()

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  postMessage(message: unknown): void {
    this.posted.push(message)
    this.onPost?.(message, this)
  }

  terminate(): void {
    this.terminated = true
  }

  emitMessage(data: unknown): void {
    for (const listener of this.listeners.get('message') ?? []) listener({ data })
  }

  emitError(): void {
    for (const listener of this.listeners.get('error') ?? []) listener({})
  }

  asWorker(): Worker {
    return this as unknown as Worker
  }
}

function workspace(): WorkspaceApi {
  return {
    list: async () => [{ name: 'a.txt', path: 'a.txt', kind: 'file' }],
    readFile: async () => 'hello world',
    writeFile: async () => {},
    makeDir: async () => {},
    remove: async () => {},
    stat: async () => ({ path: '', kind: 'file', size: 0 }),
    move: async (from, to) => ({ from, to, kind: 'file', size: 0 }),
    copy: async (from, to) => ({ from, to, kind: 'file', size: 0 }),
    search: async () => ({ hits: [], truncated: false, filesScanned: 0, filesSkipped: 0 }),
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('createSearchRunner', () => {
  it('resolves the search-done result', async () => {
    const worker = new FakeWorker()
    worker.onPost = (message, target) => {
      if ((message as { kind?: unknown }).kind === 'search') {
        target.emitMessage({
          kind: 'search-done',
          result: { hits: [], truncated: false, filesScanned: 0, filesSkipped: 0 },
        })
      }
    }
    const runner = createSearchRunner({ workerFactory: () => worker.asWorker(), workspace: workspace() })
    await expect(runner.search({ pattern: 'x' })).resolves.toEqual({
      hits: [],
      truncated: false,
      filesScanned: 0,
      filesSkipped: 0,
    })
  })

  it('answers an fs.call from the worker instead of resolving', async () => {
    const worker = new FakeWorker()
    const seen: string[] = []
    worker.onPost = (message, target) => {
      if ((message as { kind?: unknown }).kind === 'search') {
        target.emitMessage({ kind: 'fs.call', requestId: 'r1', op: 'read', path: 'a.txt' })
        return
      }
      if ((message as { kind?: unknown }).kind === 'fs.result') {
        seen.push((message as { data: string }).data)
        target.emitMessage({
          kind: 'search-done',
          result: { hits: [{ path: 'a.txt', line: 1, text: 'hello world' }], truncated: false, filesScanned: 1, filesSkipped: 0 },
        })
      }
    }
    const runner = createSearchRunner({ workerFactory: () => worker.asWorker(), workspace: workspace() })
    const result = await runner.search({ pattern: 'hello' })
    expect(seen).toEqual(['hello world'])
    expect(result.hits).toHaveLength(1)
  })

  it('terminates the worker and rejects on timeout', async () => {
    const worker = new FakeWorker()
    const runner = createSearchRunner({
      workerFactory: () => worker.asWorker(),
      workspace: workspace(),
      timeoutMs: 5,
    })
    await expect(runner.search({ pattern: 'x' })).rejects.toMatchObject({ code: 'timeout' })
    expect(worker.terminated).toBe(true)
  })

  it('reports a worker that dies before search-done and respawns next time', async () => {
    const first = new FakeWorker()
    const second = new FakeWorker()
    const factory = vi.fn().mockReturnValueOnce(first.asWorker()).mockReturnValueOnce(second.asWorker())
    second.onPost = (message, target) => {
      if ((message as { kind?: unknown }).kind === 'search') {
        target.emitMessage({ kind: 'search-done', result: { hits: [], truncated: false, filesScanned: 0, filesSkipped: 0 } })
      }
    }
    const runner = createSearchRunner({ workerFactory: factory, workspace: workspace() })

    const pending = runner.search({ pattern: 'x' })
    await tick()
    first.emitError()
    await expect(pending).rejects.toMatchObject({ code: 'runtime_error' })

    await expect(runner.search({ pattern: 'x' })).resolves.toMatchObject({ hits: [] })
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('rejects a malformed pattern reported by the worker', async () => {
    const worker = new FakeWorker()
    worker.onPost = (message, target) => {
      if ((message as { kind?: unknown }).kind === 'search') {
        target.emitMessage({ kind: 'search-error', code: 'invalid_input', message: 'bad', hint: 'fix it' })
      }
    }
    const runner = createSearchRunner({ workerFactory: () => worker.asWorker(), workspace: workspace() })
    await expect(runner.search({ pattern: '(' })).rejects.toMatchObject({ code: 'invalid_input', hint: 'fix it' })
  })

  it('uses the default timeout constant', () => {
    expect(SEARCH_TIMEOUT_MS).toBe(5000)
  })
})
