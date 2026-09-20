import { describe, expect, it } from 'vitest'
import { createFakeWorkspace } from '../workspace/fake-handle'
import { createWorkspaceFs } from '../workspace/fs'
import type { WorkspaceApi } from '../tools/types'
import { SandboxTimeoutError } from './protocol'
import { WorkerSession } from './session'
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function session(factory: WorkerFactory, overrides: Record<string, unknown> = {}): WorkerSession {
  return new WorkerSession({
    workerFactory: factory,
    language: 'js',
    defaultTimeoutMs: 1_000,
    ...overrides,
  })
}

function resolveRun(worker: FakePortWorker, stdout: string, extra: Record<string, unknown> = {}): void {
  worker.setHandler((message, target) => {
    if (kindOf(message) !== 'run') return
    target.emit({ kind: 'result', runId: runIdOf(message), stdout, stderr: '', result: null, ...extra })
  })
}

const hangingWorkspace: WorkspaceApi = {
  readFile: () => new Promise<string>(() => {}),
  writeFile: async () => {},
  list: async () => [],
  makeDir: async () => {},
  remove: async () => {},
  stat: async () => ({ path: '', kind: 'directory', size: 0 }),
  move: async (from, to) => ({ from, to, kind: 'file', size: 0 }),
  copy: async (from, to) => ({ from, to, kind: 'file', size: 0 }),
  search: async () => ({ hits: [], truncated: false, filesScanned: 0, filesSkipped: 0 }),
}

describe('WorkerSession', () => {
  it('reuses one warm worker across sequential runs', async () => {
    const { factory, workers } = makeFactory()
    const active = session(factory)
    const first = active.run('a')
    await tick()
    resolveRun(workers[0], 'one')
    await expect(first).resolves.toMatchObject({ stdout: 'one' })

    const second = active.run('b')
    await expect(second).resolves.toMatchObject({ stdout: 'one' })
    expect(workers).toHaveLength(1)
    active.dispose()
  })

  it('serializes two concurrent runs', async () => {
    const { factory, workers } = makeFactory()
    const active = session(factory)
    const order: string[] = []
    const first = active.run('one')
    const second = active.run('two')
    await tick()
    workers[0].setHandler((message, target) => {
      if (kindOf(message) !== 'run') return
      const source = (message as { source: string }).source
      order.push(source)
      setTimeout(() => {
        target.emit({ kind: 'result', runId: runIdOf(message), stdout: `out:${source}`, stderr: '', result: null })
      }, 5)
    })
    await expect(first).resolves.toMatchObject({ stdout: 'out:one' })
    await expect(second).resolves.toMatchObject({ stdout: 'out:two' })
    expect(order).toEqual(['one', 'two'])
    active.dispose()
  })

  it('terminates on timeout and respawns on the next run', async () => {
    const { factory, workers } = makeFactory()
    const active = session(factory)
    const first = active.run('x', { timeoutMs: 20 })
    await tick()
    workers[0].setHandler(() => {})
    await expect(first).rejects.toBeInstanceOf(SandboxTimeoutError)
    expect(workers[0].terminated).toBe(true)

    const second = active.run('y')
    await tick()
    expect(workers).toHaveLength(2)
    resolveRun(workers[1], 'ok')
    await expect(second).resolves.toMatchObject({ stdout: 'ok' })
    active.dispose()
  })

  it('respawns after a fatal result', async () => {
    const { factory, workers } = makeFactory()
    const active = session(factory)
    const first = active.run('x')
    await tick()
    resolveRun(workers[0], '', { error: 'boom', fatal: true })
    await expect(first).resolves.toMatchObject({ error: 'boom' })
    expect(workers[0].terminated).toBe(true)
    active.dispose()
  })

  it('ignores an inbound message with a mismatched runId', async () => {
    const { factory, workers } = makeFactory()
    const active = session(factory)
    const pending = active.run('x')
    await tick()
    workers[0].setHandler((message, target) => {
      if (kindOf(message) !== 'run') return
      target.emit({ kind: 'result', runId: 'other', stdout: 'bad', stderr: '', result: null })
      target.emit({ kind: 'result', runId: runIdOf(message), stdout: 'good', stderr: '', result: null })
    })
    await expect(pending).resolves.toMatchObject({ stdout: 'good' })
    active.dispose()
  })

  it('terminates the warm worker after the idle timeout', async () => {
    const { factory, workers } = makeFactory()
    const active = session(factory, { idleTimeoutMs: 20 })
    const first = active.run('x')
    await tick()
    resolveRun(workers[0], 'one')
    await first

    await sleep(40)
    expect(workers[0].terminated).toBe(true)

    const second = active.run('y')
    await tick()
    expect(workers).toHaveLength(2)
    resolveRun(workers[1], 'two')
    await expect(second).resolves.toMatchObject({ stdout: 'two' })
    active.dispose()
  })

  it('re-arms the idle timer on activity', async () => {
    const { factory, workers } = makeFactory()
    const active = session(factory, { idleTimeoutMs: 30 })
    const first = active.run('x')
    await tick()
    resolveRun(workers[0], 'one')
    await first

    await sleep(20)
    resolveRun(workers[0], 'two')
    const second = active.run('y')
    await sleep(20)
    expect(workers).toHaveLength(1)
    expect(workers[0].terminated).toBe(false)
    await expect(second).resolves.toMatchObject({ stdout: 'two' })
    active.dispose()
  })

  it('terminates and rejects a run that stays silent past the idle deadline', async () => {
    const { factory, workers } = makeFactory()
    const active = session(factory, { idleTimeoutMs: 20, workspace: hangingWorkspace })
    const pending = active.run('x', { timeoutMs: 10_000 })
    await tick()
    workers[0].setHandler((message, target) => {
      if (kindOf(message) === 'run') {
        target.emit({ kind: 'fs.call', runId: runIdOf(message), requestId: 'q1', op: 'read', path: 'hang.txt' })
      }
    })
    await expect(pending).rejects.toBeInstanceOf(SandboxTimeoutError)
    expect(workers[0].terminated).toBe(true)
    active.dispose()
  })

  it('terminates and respawns after a between-runs session-fatal message', async () => {
    const { factory, workers } = makeFactory()
    const active = session(factory)
    const first = active.run('x')
    await tick()
    resolveRun(workers[0], 'one')
    await first

    workers[0].emit({ kind: 'fatal', message: 'worker died' })
    await tick()
    expect(workers[0].terminated).toBe(true)

    const second = active.run('y')
    await tick()
    expect(workers).toHaveLength(2)
    resolveRun(workers[1], 'two')
    await expect(second).resolves.toMatchObject({ stdout: 'two' })
    active.dispose()
  })

  it('reset terminates an in-flight run and the next run respawns', async () => {
    const { factory, workers } = makeFactory()
    const active = session(factory)
    const pending = active.run('x')
    await tick()
    workers[0].setHandler(() => {})

    active.reset()
    expect(workers[0].terminated).toBe(true)
    await expect(pending).rejects.toBeInstanceOf(SandboxTimeoutError)

    const second = active.run('y')
    await tick()
    expect(workers).toHaveLength(2)
    resolveRun(workers[1], 'ok')
    await expect(second).resolves.toMatchObject({ stdout: 'ok' })
    active.dispose()
  })
})

describe('WorkerSession workspace bridge', () => {
  it('routes an fs.call through the workspace', async () => {
    const fake = createFakeWorkspace({ 'a.txt': 'content' })
    const workspace = createWorkspaceFs(fake.handle)
    const { factory, workers } = makeFactory()
    const active = session(factory, { workspace })
    const pending = active.run('x')
    await tick()
    let activeRunId = ''
    workers[0].setHandler((message, target) => {
      if (kindOf(message) === 'run') {
        activeRunId = runIdOf(message)
        target.emit({ kind: 'fs.call', runId: activeRunId, requestId: 'q1', op: 'read', path: 'a.txt' })
        return
      }
      if (kindOf(message) === 'fs.result') {
        target.emit({
          kind: 'result',
          runId: activeRunId,
          stdout: (message as { data: string }).data,
          stderr: '',
          result: null,
        })
      }
    })
    await expect(pending).resolves.toMatchObject({ stdout: 'content' })
    active.dispose()
  })
})
