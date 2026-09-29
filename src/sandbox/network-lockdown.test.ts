import { describe, expect, it } from 'vitest'
import jsWorkerSource from './js-worker.ts?raw'
import { BLOCKED_WORKER_GLOBALS, lockDownNetwork } from './network-lockdown'
import pyWorkerSource from './py-worker.ts?raw'

describe('lockDownNetwork', () => {
  it('removes every socket-capable constructor so sandboxed code cannot open a WebSocket to the bridge', () => {
    const scope: Record<string, unknown> = {
      WebSocket: class {},
      WebSocketStream: class {},
      EventSource: class {},
      WebTransport: class {},
      Worker: class {},
      SharedWorker: class {},
      fetch: () => undefined,
    }
    lockDownNetwork(scope)
    for (const name of BLOCKED_WORKER_GLOBALS) expect(typeof scope[name]).toBe('undefined')
    expect(typeof scope.fetch).toBe('function')
  })
})

describe('sandbox workers', () => {
  it.each([
    ['js-worker', jsWorkerSource],
    ['py-worker', pyWorkerSource],
  ])(
    '%s locks the network down at module load, before it can receive code to run',
    (_name, source) => {
      const lock = source.indexOf('\nlockDownNetwork()')
      expect(lock).toBeGreaterThan(-1)
      expect(lock).toBeLessThan(source.indexOf('ctx.onmessage'))
    },
  )
})
