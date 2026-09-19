import { describe, expect, it } from 'vitest'
import type { WorkspaceApi } from '../tools/types'
import { createSandboxManager } from './manager'
import type { SandboxManagerOptions } from './manager'
import type { WorkerFactory } from './worker-factory'

class FakeWorker {
  private readonly listeners = new Set<(event: MessageEvent) => void>()
  terminated = false
  onPost: ((message: unknown, worker: FakeWorker) => void) | null = null

  postMessage(message: unknown): void {
    this.onPost?.(message, this)
  }

  addEventListener(_type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.add(listener)
  }

  removeEventListener(_type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.delete(listener)
  }

  terminate(): void {
    this.terminated = true
  }

  emit(data: unknown): void {
    for (const listener of this.listeners) listener({ data } as MessageEvent)
  }
}

function kindOf(message: unknown): string {
  return (message as { kind?: string }).kind ?? ''
}

function runIdOf(message: unknown): string {
  return (message as { runId: string }).runId
}

/** Each `factory()` call pops the next queued worker, so tests can set `onPost` first. */
function queuedFactory(): { queue: FakeWorker[]; factory: WorkerFactory } {
  const queue: FakeWorker[] = []
  const factory: WorkerFactory = () => {
    const worker = queue.shift()
    if (!worker) throw new Error('no fake worker queued')
    return worker as unknown as Worker
  }
  return { queue, factory }
}

const SETTINGS = { enabled: true, jsTimeoutMs: 5_000, pyTimeoutMs: 5_000 }

function options(overrides: Partial<SandboxManagerOptions> = {}): SandboxManagerOptions {
  return { settings: SETTINGS, ...overrides }
}

function resolveWith(worker: FakeWorker, result: { stdout: string; result: string | null }): void {
  worker.onPost = (message, target) => {
    if (kindOf(message) !== 'run') return
    target.emit({
      kind: 'result',
      runId: runIdOf(message),
      stdout: result.stdout,
      stderr: '',
      result: result.result,
    })
  }
}

describe('createSandboxManager', () => {
  it('runs JavaScript and records the last run', async () => {
    const { queue, factory } = queuedFactory()
    const manager = createSandboxManager(options({ workerFactory: { js: factory } }))
    const worker = new FakeWorker()
    resolveWith(worker, { stdout: 'hi', result: '2' })
    queue.push(worker)

    await expect(manager.run('js', '1+1')).resolves.toEqual({ stdout: 'hi', stderr: '', result: '2' })
    expect(manager.lastRun()).toMatchObject({ language: 'js' })
  })

  it('records a timeout as an error instead of throwing', async () => {
    const { queue, factory } = queuedFactory()
    const manager = createSandboxManager(
      options({ settings: { ...SETTINGS, jsTimeoutMs: 20 }, workerFactory: { js: factory } }),
    )
    const worker = new FakeWorker()
    worker.onPost = () => {}
    queue.push(worker)

    const result = await manager.run('js', 'while(true){}')
    expect(typeof result.error).toBe('string')
    expect(result.error).toBeTruthy()
    expect(manager.lastRun()?.error).toBeTruthy()
  })

  it('records an error when the sandbox is disabled and never runs', async () => {
    const { queue, factory } = queuedFactory()
    const manager = createSandboxManager(
      options({ settings: { ...SETTINGS, enabled: false }, workerFactory: { js: factory } }),
    )
    const result = await manager.run('js', '1')
    expect(result.error).toContain('disabled')
    expect(queue).toHaveLength(0)
  })

  it('rebuilds immediately when idle and disposes the previous runners', () => {
    const manager = createSandboxManager(options())
    const before = manager.toolRunners()
    manager.setSettings({ ...SETTINGS, jsTimeoutMs: 1234 })
    expect(manager.toolRunners()).not.toBe(before)
  })

  it('defers a runner rebuild until the in-flight run settles', async () => {
    const { queue, factory } = queuedFactory()
    const manager = createSandboxManager(
      options({ settings: { ...SETTINGS, jsTimeoutMs: 20 }, workerFactory: { js: factory } }),
    )
    const worker = new FakeWorker()
    worker.onPost = () => {}
    queue.push(worker)

    const before = manager.toolRunners()
    const pending = manager.run('js', 'while(true){}')
    expect(worker.terminated).toBe(false)

    manager.setSettings({ ...SETTINGS, jsTimeoutMs: 50 })
    // The live run must not be killed by the settings change.
    expect(worker.terminated).toBe(false)
    expect(manager.toolRunners()).toBe(before)

    await expect(pending).resolves.toMatchObject({ result: null })
    expect(manager.toolRunners()).not.toBe(before)
  })

  it('does not rebuild on an unchanged settings write', () => {
    const manager = createSandboxManager(options())
    const before = manager.toolRunners()
    manager.setSettings({ ...SETTINGS })
    expect(manager.toolRunners()).toBe(before)
  })

  it('routes console runs file-less and workspace runs through the bound workspace', async () => {
    let readCalls = 0
    const workspace: WorkspaceApi = {
      readFile: async (path) => {
        readCalls += 1
        return `content:${path}`
      },
      writeFile: async () => {},
      list: async () => [],
      makeDir: async () => {},
      remove: async () => {},
      stat: async () => ({ path: '', kind: 'file', size: 0 }),
    }
    const { queue, factory } = queuedFactory()
    const manager = createSandboxManager(options({ workspace, workerFactory: { js: factory } }))

    let runId = ''
    const handler = (message: unknown, target: FakeWorker) => {
      if (kindOf(message) === 'run') {
        runId = runIdOf(message)
        target.emit({ kind: 'fs.call', runId, requestId: 'q1', op: 'read', path: 'a.txt' })
        return
      }
      if (kindOf(message) === 'fs.result') {
        target.emit({
          kind: 'result',
          runId,
          stdout: (message as { data: string }).data,
          stderr: '',
          result: null,
        })
      }
      if (kindOf(message) === 'fs.error') {
        target.emit({
          kind: 'result',
          runId,
          stdout: '',
          stderr: '',
          result: null,
          error: 'No workspace is available to the sandbox.',
        })
      }
    }

    const consoleWorker = new FakeWorker()
    consoleWorker.onPost = handler
    queue.push(consoleWorker)
    const consoleResult = await manager.run('js', 'read')
    expect(readCalls).toBe(0)
    expect(consoleResult.error).toContain('workspace')

    const boundWorker = new FakeWorker()
    boundWorker.onPost = handler
    queue.push(boundWorker)
    const boundResult = await manager.run('js', 'read', { workspace: true })
    expect(readCalls).toBe(1)
    expect(boundResult.stdout).toBe('content:a.txt')
  })

  it('reports availability from Worker support', () => {
    const manager = createSandboxManager(options())
    const original = (globalThis as { Worker?: unknown }).Worker
    ;(globalThis as { Worker?: unknown }).Worker = class {}
    expect(manager.availability()).toEqual({ js: true, python: true })
    ;(globalThis as { Worker?: unknown }).Worker = undefined
    const unavailable = manager.availability()
    expect(unavailable.js).toBe(false)
    expect(unavailable.reason).toBeTruthy()
    ;(globalThis as { Worker?: unknown }).Worker = original
  })
})
