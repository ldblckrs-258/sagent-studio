import { describe, expect, it } from 'vitest'
import { normalizeLockPath, resetPathLocks, withPathLock, withWorkspaceLock } from './lock'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('withPathLock', () => {
  it('runs tasks for the same path one at a time', async () => {
    const order: string[] = []
    const gate = deferred()
    const first = withPathLock('a.txt', async () => {
      order.push('first:start')
      await gate.promise
      order.push('first:end')
    })
    const second = withPathLock('a.txt', async () => {
      order.push('second:start')
    })
    await Promise.resolve()
    expect(order).toEqual(['first:start'])
    gate.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
  })

  it('runs different paths concurrently', async () => {
    const order: string[] = []
    const gate = deferred()
    const first = withPathLock('a.txt', async () => {
      await gate.promise
      order.push('a')
    })
    const second = withPathLock('b.txt', async () => {
      order.push('b')
    })
    await Promise.resolve()
    expect(order).toEqual(['b'])
    gate.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['b', 'a'])
  })

  it('keeps draining the lane after a task rejects', async () => {
    await expect(
      withPathLock('a.txt', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    await expect(withPathLock('a.txt', async () => 'ok')).resolves.toBe('ok')
  })

  it('holds a path task behind a workspace-wide task claimed first', async () => {
    resetPathLocks()
    const order: string[] = []
    const gate = deferred()
    const wide = withWorkspaceLock(async () => {
      order.push('wide:start')
      await gate.promise
      order.push('wide:end')
    })
    const scoped = withPathLock('a.txt', async () => {
      order.push('scoped')
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    gate.resolve()
    await Promise.all([wide, scoped])
    expect(order).toEqual(['wide:start', 'wide:end', 'scoped'])
  })

  it('waits for an in-flight path task before running a workspace-wide task', async () => {
    resetPathLocks()
    const order: string[] = []
    const gate = deferred()
    const scoped = withPathLock('a.txt', async () => {
      await gate.promise
      order.push('scoped')
    })
    const wide = withWorkspaceLock(async () => {
      order.push('wide')
    })
    gate.resolve()
    await Promise.all([scoped, wide])
    expect(order).toEqual(['scoped', 'wide'])
  })

  it('canonicalizes equivalent path spellings to one lane', () => {
    expect(normalizeLockPath('./src/./a.ts')).toBe('src/a.ts')
    expect(normalizeLockPath('src/x/../a.ts')).toBe('src/a.ts')
    expect(normalizeLockPath('src/a.ts/')).toBe('src/a.ts')
  })
})
