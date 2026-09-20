import { describe, expect, it } from 'vitest'
import { createFakeWorkspace } from '../workspace/fake-handle'
import { createWorkspaceFs } from '../workspace/fs'
import type { WorkspaceApi } from '../tools/types'
import { JsRunner } from './js-runner'
import { SandboxTimeoutError } from './protocol'
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

function responder(worker: FakePortWorker, stdout: string, result: string | null = null): void {
  worker.setHandler((message, target) => {
    if (kindOf(message) !== 'run') return
    target.emit({ kind: 'result', runId: runIdOf(message), stdout, stderr: '', result })
  })
}

function runner(factory: WorkerFactory, extra: Record<string, unknown> = {}): JsRunner {
  return new JsRunner({ workerFactory: factory, idleTimeoutMs: 0, ...extra })
}

describe('JsRunner', () => {
  it('resolves a structured result and reuses the warm worker', async () => {
    const { factory, workers } = makeFactory()
    const active = runner(factory)

    const first = active.run('return 42', {})
    await tick()
    responder(workers[0], 'hi', '42')
    await expect(first).resolves.toEqual({ stdout: 'hi', stderr: '', result: '42' })
    expect(workers).toHaveLength(1)

    const second = active.run('return 7', {})
    await expect(second).resolves.toEqual({ stdout: 'hi', stderr: '', result: '42' })
    expect(workers).toHaveLength(1)
    expect(workers[0].terminated).toBe(false)
    active.dispose()
  })

  it('caps stdout and stderr at 64 KiB', async () => {
    const { factory, workers } = makeFactory()
    const active = runner(factory)
    const pending = active.run('x', {})
    await tick()
    workers[0].setHandler((message, target) => {
      if (kindOf(message) !== 'run') return
      target.emit({
        kind: 'result',
        runId: runIdOf(message),
        stdout: 'a'.repeat(70_000),
        stderr: 'b'.repeat(70_000),
        result: null,
      })
    })

    const result = await pending
    expect(new TextEncoder().encode(result.stdout).byteLength).toBe(65_536)
    expect(new TextEncoder().encode(result.stderr).byteLength).toBe(65_536)
    active.dispose()
  })

  it('terminates the worker and rejects on timeout, then respawns', async () => {
    const { factory, workers } = makeFactory()
    const active = runner(factory)
    const first = active.run('while(true){}', { timeoutMs: 20 })
    await tick()
    workers[0].setHandler(() => {})

    await expect(first).rejects.toBeInstanceOf(SandboxTimeoutError)
    expect(workers[0].terminated).toBe(true)

    const second = active.run('ok', {})
    await tick()
    expect(workers).toHaveLength(2)
    responder(workers[1], 'fine')
    await expect(second).resolves.toMatchObject({ stdout: 'fine' })
    active.dispose()
  })

  it('routes fs.call through the workspace', async () => {
    const fake = createFakeWorkspace({ 'a.txt': 'content' })
    const workspace = createWorkspaceFs(fake.handle)
    const { factory, workers } = makeFactory()
    const active = runner(factory, { workspace })
    const pending = active.run('await fs.readFile("a.txt")', {})
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

  it('rejects every pending fs RPC when it times out', async () => {
    const hanging: WorkspaceApi = {
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
    const { factory, workers } = makeFactory()
    const active = runner(factory, { workspace: hanging })
    const pending = active.run('await fs.readFile("hang.txt")', { timeoutMs: 20 })
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

  it('ignores inbound messages with a mismatched runId', async () => {
    const { factory, workers } = makeFactory()
    const active = runner(factory)
    const pending = active.run('x', {})
    await tick()
    workers[0].setHandler((message, target) => {
      if (kindOf(message) !== 'run') return
      target.emit({ kind: 'result', runId: 'other', stdout: 'bad', stderr: '', result: null })
      target.emit({ kind: 'result', runId: runIdOf(message), stdout: 'good', stderr: '', result: null })
    })

    await expect(pending).resolves.toMatchObject({ stdout: 'good' })
    active.dispose()
  })

  it('dispose terminates an in-flight worker', async () => {
    const { factory, workers } = makeFactory()
    const active = runner(factory)
    const pending = active.run('while(true){}', { timeoutMs: 30 })
    await tick()
    workers[0].setHandler(() => {})

    active.dispose()
    expect(workers[0].terminated).toBe(true)
    await expect(pending).rejects.toBeInstanceOf(SandboxTimeoutError)
  })

  it('terminates the warm worker after the idle timeout when configured', async () => {
    const { factory, workers } = makeFactory()
    const active = new JsRunner({ workerFactory: factory, idleTimeoutMs: 20 })
    const first = active.run('x', {})
    await tick()
    responder(workers[0], 'one')
    await first

    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(workers[0].terminated).toBe(true)
    active.dispose()
  })

  it.runIf(typeof Worker !== 'undefined')('completes two warm runs over the real worker port protocol', async () => {
    const active = new JsRunner({ idleTimeoutMs: 0 })
    const first = await active.run('return { n: 1 }', {})
    expect(first.error).toBeUndefined()
    expect(first.result).toContain('"n":1')
    const second = await active.run('JSON.stringify = () => "poisoned"; return { n: 2 }', {})
    expect(second.error).toBeUndefined()
    expect(second.result).toContain('"n":2')
    const third = await active.run('return { n: 3 }', {})
    expect(third.result).toContain('"n":3')
    active.dispose()
  })
})
