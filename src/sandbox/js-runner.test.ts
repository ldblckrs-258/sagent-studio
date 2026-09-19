import { describe, expect, it } from 'vitest'
import { createFakeWorkspace } from '../workspace/fake-handle'
import { createWorkspaceFs } from '../workspace/fs'
import type { WorkspaceApi } from '../tools/types'
import { JsRunner } from './js-runner'
import { SandboxTimeoutError } from './protocol'
import type { WorkerFactory } from './worker-factory'

class FakeWorker {
  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>()
  readonly posted: unknown[] = []
  terminated = false
  onPost: ((message: unknown, worker: FakeWorker) => void) | null = null

  postMessage(message: unknown): void {
    this.posted.push(message)
    this.onPost?.(message, this)
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)?.add(listener)
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  terminate(): void {
    this.terminated = true
  }

  emit(data: unknown): void {
    for (const listener of this.listeners.get('message') ?? []) listener({ data } as MessageEvent)
  }

  listenerCount(): number {
    return this.listeners.get('message')?.size ?? 0
  }
}

function kindOf(message: unknown): string {
  return (message as { kind?: string }).kind ?? ''
}

function runIdOf(message: unknown): string {
  return (message as { runId: string }).runId
}

describe('JsRunner', () => {
  it('resolves a structured result and disposes the worker', async () => {
    const worker = new FakeWorker()
    const factory: WorkerFactory = () => worker as unknown as Worker
    const runner = new JsRunner({ workerFactory: factory })
    worker.onPost = (message, target) => {
      if (kindOf(message) !== 'run') return
      target.emit({ kind: 'result', runId: runIdOf(message), stdout: 'hi', stderr: '', result: '42' })
    }

    await expect(runner.run('return 42', {})).resolves.toEqual({
      stdout: 'hi',
      stderr: '',
      result: '42',
    })
    expect(worker.terminated).toBe(true)
    expect(worker.listenerCount()).toBe(0)
  })

  it('caps stdout and stderr at 64 KiB', async () => {
    const worker = new FakeWorker()
    const factory: WorkerFactory = () => worker as unknown as Worker
    const runner = new JsRunner({ workerFactory: factory })
    worker.onPost = (message, target) => {
      if (kindOf(message) !== 'run') return
      target.emit({
        kind: 'result',
        runId: runIdOf(message),
        stdout: 'a'.repeat(70_000),
        stderr: 'b'.repeat(70_000),
        result: null,
      })
    }

    const result = await runner.run('x', {})
    expect(new TextEncoder().encode(result.stdout).byteLength).toBe(65_536)
    expect(new TextEncoder().encode(result.stderr).byteLength).toBe(65_536)
  })

  it('terminates the worker and rejects on timeout', async () => {
    const worker = new FakeWorker()
    const factory: WorkerFactory = () => worker as unknown as Worker
    const runner = new JsRunner({ workerFactory: factory })
    worker.onPost = () => {}

    await expect(runner.run('while(true){}', { timeoutMs: 50 })).rejects.toBeInstanceOf(
      SandboxTimeoutError,
    )
    expect(worker.terminated).toBe(true)
    expect(worker.listenerCount()).toBe(0)
  })

  it('routes fs.call through the workspace', async () => {
    const fake = createFakeWorkspace({ 'a.txt': 'content' })
    const workspace = createWorkspaceFs(fake.handle)
    const worker = new FakeWorker()
    const factory: WorkerFactory = () => worker as unknown as Worker
    const runner = new JsRunner({ workerFactory: factory, workspace })
    let activeRunId = ''
    worker.onPost = (message, target) => {
      if (kindOf(message) === 'run') {
        activeRunId = runIdOf(message)
        target.emit({
          kind: 'fs.call',
          runId: activeRunId,
          requestId: 'q1',
          op: 'read',
          path: 'a.txt',
        })
        return
      }
      if (kindOf(message) === 'fs.result') {
        expect((message as { requestId: string }).requestId).toBe('q1')
        target.emit({
          kind: 'result',
          runId: activeRunId,
          stdout: (message as { data: string }).data,
          stderr: '',
          result: null,
        })
      }
    }

    await expect(runner.run('await fs.readFile("a.txt")', {})).resolves.toMatchObject({
      stdout: 'content',
    })
  })

  it('rejects every pending fs RPC when it times out', async () => {
    const hanging: WorkspaceApi = {
      readFile: () => new Promise<string>(() => {}),
      writeFile: async () => {},
      list: async () => [],
      makeDir: async () => {},
      remove: async () => {},
      stat: async () => ({ path: '', kind: 'directory', size: 0 }),
    }
    const worker = new FakeWorker()
    const factory: WorkerFactory = () => worker as unknown as Worker
    const runner = new JsRunner({ workerFactory: factory, workspace: hanging })
    worker.onPost = (message, target) => {
      if (kindOf(message) === 'run') {
        target.emit({
          kind: 'fs.call',
          runId: runIdOf(message),
          requestId: 'q1',
          op: 'read',
          path: 'hang.txt',
        })
      }
    }

    await expect(runner.run('await fs.readFile("hang.txt")', { timeoutMs: 50 })).rejects.toBeInstanceOf(
      SandboxTimeoutError,
    )
    expect(worker.terminated).toBe(true)
  })

  it('ignores inbound messages with a mismatched runId', async () => {
    const worker = new FakeWorker()
    const factory: WorkerFactory = () => worker as unknown as Worker
    const runner = new JsRunner({ workerFactory: factory })
    worker.onPost = (message, target) => {
      if (kindOf(message) !== 'run') return
      target.emit({ kind: 'result', runId: 'other', stdout: 'bad', stderr: '', result: null })
      target.emit({ kind: 'result', runId: runIdOf(message), stdout: 'good', stderr: '', result: null })
    }

    await expect(runner.run('x', {})).resolves.toMatchObject({ stdout: 'good' })
  })

  it('dispose terminates an in-flight worker', async () => {
    const worker = new FakeWorker()
    const factory: WorkerFactory = () => worker as unknown as Worker
    const runner = new JsRunner({ workerFactory: factory })
    worker.onPost = () => {}

    const pending = runner.run('while(true){}', { timeoutMs: 30 })
    expect(worker.terminated).toBe(false)
    runner.dispose()
    expect(worker.terminated).toBe(true)
    await expect(pending).rejects.toBeInstanceOf(SandboxTimeoutError)
  })

  it('stops posting to the worker after it is disposed', async () => {
    const worker = new FakeWorker()
    const factory: WorkerFactory = () => worker as unknown as Worker
    const runner = new JsRunner({ workerFactory: factory })
    worker.onPost = (message, target) => {
      if (kindOf(message) === 'run') {
        target.emit({ kind: 'result', runId: runIdOf(message), stdout: '', stderr: '', result: null })
      }
    }

    await runner.run('x', {})
    const postsAfterSettle = worker.posted.length
    worker.emit({ kind: 'result', runId: 'js-1', stdout: 'late', stderr: '', result: null })
    expect(worker.posted.length).toBe(postsAfterSettle)
  })
})
