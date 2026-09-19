import { describe, expect, it } from 'vitest'
import { createFakeWorkspace } from '../workspace/fake-handle'
import { createWorkspaceFs } from '../workspace/fs'
import type { WorkspaceApi } from '../tools/types'
import { SandboxTimeoutError } from './protocol'
import { PyRunner } from './py-runner'
import type { WorkerFactory } from './worker-factory'

class FakePortWorker {
  terminated = false
  private port: MessagePort | null = null
  private handler: ((data: unknown, worker: FakePortWorker) => void) | null = null
  private buffered: unknown[] = []

  postMessage(message: unknown, transfer?: Transferable[]): void {
    if ((message as { kind?: string }).kind !== 'init') return
    const transferred = transfer?.[0]
    if (!transferred) return
    this.port = transferred as MessagePort
    this.port.onmessage = (event) => {
      if (this.handler) this.handler(event.data, this)
      else this.buffered.push(event.data)
    }
    this.port.start()
  }

  setHandler(handler: (data: unknown, worker: FakePortWorker) => void): void {
    this.handler = handler
    for (const data of this.buffered) handler(data, this)
    this.buffered = []
  }

  terminate(): void {
    this.terminated = true
  }

  emit(data: unknown): void {
    this.port?.postMessage(data)
  }
}

function kindOf(message: unknown): string {
  return (message as { kind?: string }).kind ?? ''
}

function runIdOf(message: unknown): string {
  return (message as { runId: string }).runId
}

function makeFactory(): { factory: WorkerFactory; workers: FakePortWorker[] } {
  const workers: FakePortWorker[] = []
  const factory: WorkerFactory = () => {
    const worker = new FakePortWorker()
    workers.push(worker)
    return worker as unknown as Worker
  }
  return { factory, workers }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const hangingWorkspace: WorkspaceApi = {
  readFile: () => new Promise<string>(() => {}),
  writeFile: async () => {},
  list: async () => [],
  makeDir: async () => {},
  remove: async () => {},
  stat: async () => ({ path: '', kind: 'directory', size: 0 }),
}

describe('PyRunner', () => {
  it('resolves a result and reuses the warm worker', async () => {
    const { factory, workers } = makeFactory()
    const runner = new PyRunner({ workerFactory: factory })
    const first = runner.run('print(1)', {})
    await tick()
    workers[0].setHandler((message, worker) => {
      if (kindOf(message) !== 'run') return
      worker.emit({ kind: 'result', runId: runIdOf(message), stdout: '1', stderr: '', result: null })
    })
    await expect(first).resolves.toEqual({ stdout: '1', stderr: '', result: null })

    const second = runner.run('print(2)', {})
    await expect(second).resolves.toEqual({ stdout: '1', stderr: '', result: null })
    expect(workers).toHaveLength(1)
  })

  it('terminates and respawns on timeout', async () => {
    const { factory, workers } = makeFactory()
    const runner = new PyRunner({ workerFactory: factory })
    const first = runner.run('while True: pass', { timeoutMs: 50 })
    await tick()
    workers[0].setHandler(() => {})
    await expect(first).rejects.toBeInstanceOf(SandboxTimeoutError)
    expect(workers[0].terminated).toBe(true)

    const second = runner.run('print(2)', {})
    await tick()
    expect(workers).toHaveLength(2)
    workers[1].setHandler((message, worker) => {
      if (kindOf(message) !== 'run') return
      worker.emit({ kind: 'result', runId: runIdOf(message), stdout: 'ok', stderr: '', result: null })
    })
    await expect(second).resolves.toMatchObject({ stdout: 'ok' })
  })

  it('respawns after a fatal result', async () => {
    const { factory, workers } = makeFactory()
    const runner = new PyRunner({ workerFactory: factory })
    const first = runner.run('x', {})
    await tick()
    workers[0].setHandler((message, worker) => {
      if (kindOf(message) !== 'run') return
      worker.emit({
        kind: 'result',
        runId: runIdOf(message),
        stdout: '',
        stderr: '',
        result: null,
        error: 'Pyodide failed to load',
        fatal: true,
      })
    })
    await expect(first).resolves.toMatchObject({ error: 'Pyodide failed to load' })
    expect(workers[0].terminated).toBe(true)

    const second = runner.run('y', {})
    await tick()
    expect(workers).toHaveLength(2)
    workers[1].setHandler((message, worker) => {
      if (kindOf(message) !== 'run') return
      worker.emit({ kind: 'result', runId: runIdOf(message), stdout: 'ok', stderr: '', result: null })
    })
    await expect(second).resolves.toMatchObject({ stdout: 'ok' })
  })

  it('dispose terminates the warm worker without respawning', async () => {
    const { factory, workers } = makeFactory()
    const runner = new PyRunner({ workerFactory: factory })
    const pending = runner.run('x', {})
    await tick()
    expect(workers).toHaveLength(1)

    runner.dispose()
    expect(workers[0].terminated).toBe(true)
    await expect(pending).rejects.toBeInstanceOf(SandboxTimeoutError)

    // No new worker is created by dispose.
    expect(workers).toHaveLength(1)
  })

  it('ignores an inbound message with a mismatched runId', async () => {
    const { factory, workers } = makeFactory()
    const runner = new PyRunner({ workerFactory: factory })
    const pending = runner.run('x', {})
    await tick()
    workers[0].setHandler((message, worker) => {
      if (kindOf(message) !== 'run') return
      worker.emit({ kind: 'result', runId: 'other', stdout: 'bad', stderr: '', result: null })
      worker.emit({ kind: 'result', runId: runIdOf(message), stdout: 'good', stderr: '', result: null })
    })
    await expect(pending).resolves.toMatchObject({ stdout: 'good' })
  })

  it('rejects a pending fs RPC and the run on timeout', async () => {
    const { factory, workers } = makeFactory()
    const runner = new PyRunner({ workerFactory: factory, workspace: hangingWorkspace })
    const pending = runner.run('workspace.readFile("hang")', { timeoutMs: 50 })
    await tick()
    workers[0].setHandler((message, worker) => {
      if (kindOf(message) === 'run') {
        worker.emit({
          kind: 'fs.call',
          runId: runIdOf(message),
          requestId: 'q1',
          op: 'read',
          path: 'hang.txt',
        })
      }
    })
    await expect(pending).rejects.toBeInstanceOf(SandboxTimeoutError)
    expect(workers[0].terminated).toBe(true)
  })

  it('routes a Python fs.call through the workspace and returns the data', async () => {
    const fake = createFakeWorkspace({ 'a.txt': 'content' })
    const workspace = createWorkspaceFs(fake.handle)
    const { factory, workers } = makeFactory()
    const runner = new PyRunner({ workerFactory: factory, workspace })
    const pending = runner.run('x', {})
    await tick()
    let activeRunId = ''
    workers[0].setHandler((message, worker) => {
      if (kindOf(message) === 'run') {
        activeRunId = runIdOf(message)
        worker.emit({
          kind: 'fs.call',
          runId: activeRunId,
          requestId: 'q1',
          op: 'read',
          path: 'a.txt',
        })
        return
      }
      if (kindOf(message) === 'fs.result') {
        expect((message as { data: string }).data).toBe('content')
        worker.emit({
          kind: 'result',
          runId: activeRunId,
          stdout: (message as { data: string }).data,
          stderr: '',
          result: null,
        })
      }
    })
    await expect(pending).resolves.toMatchObject({ stdout: 'content' })
  })

  it('serializes concurrent runs on the shared worker', async () => {
    const { factory, workers } = makeFactory()
    const runner = new PyRunner({ workerFactory: factory })
    const order: string[] = []

    const first = runner.run('one', {})
    const second = runner.run('two', {})
    await tick()
    workers[0].setHandler((message, worker) => {
      if (kindOf(message) !== 'run') return
      const source = (message as { source: string }).source
      order.push(`run:${source}`)
      setTimeout(() => {
        worker.emit({
          kind: 'result',
          runId: runIdOf(message),
          stdout: `out:${source}`,
          stderr: '',
          result: null,
        })
      }, 5)
    })

    await expect(first).resolves.toMatchObject({ stdout: 'out:one' })
    await expect(second).resolves.toMatchObject({ stdout: 'out:two' })
    expect(order).toEqual(['run:one', 'run:two'])
    expect(workers).toHaveLength(1)
  })
})
