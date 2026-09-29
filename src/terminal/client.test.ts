import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionInfo } from 'sagent-bridge/protocol'
import { BridgeClient, ProtocolMismatchError, type SocketLike } from './client'
import { nodeSocketFactory, startBridge, type BridgeProcess } from './test-utils/bridge-process'
import { TerminalError } from './types'

let root: string
let bridge: BridgeProcess

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'app-client-')))
  bridge = await startBridge({ root })
})

afterAll(async () => {
  await bridge.stop()
  rmSync(root, { recursive: true, force: true })
})

function client(overrides: { token?: string; origin?: string } = {}) {
  return new BridgeClient({
    url: bridge.url,
    token: overrides.token ?? bridge.token,
    clientVersion: 'test',
    socketFactory: nodeSocketFactory(overrides.origin),
  })
}

describe('BridgeClient against a real bridge', { timeout: 20000 }, () => {
  it('completes the hello handshake and reports the root name and capabilities', async () => {
    const c = client()
    const hello = await c.connect()
    expect(hello.rootName).toBe(root.split('/').pop())
    expect(hello.capabilities).toEqual(expect.arrayContaining(['exec', 'pty', 'classify']))
    c.close()
  })

  it('fails the connect when the token is wrong', async () => {
    await expect(client({ token: 'wrong_token_0123456789abcd' }).connect()).rejects.toBeInstanceOf(Error)
  })

  it('fails the connect from an origin the bridge does not allow', async () => {
    await expect(client({ origin: 'https://evil.example' }).connect()).rejects.toBeInstanceOf(Error)
  })

  it('correlates replies that arrive out of order', async () => {
    const c = client()
    await c.connect()
    const session = await c.request<SessionInfo>({
      type: 'create',
      kind: 'exec',
      command: 'sleep 30',
      shell: 'model',
      owner: { source: 'model', threadId: 't' },
    })
    const kill = c.request<{ killed: boolean }>({ type: 'kill', session: session.id }, 15000)
    const classify = c.request<{ sensitive: boolean }>({ type: 'classify', command: 'ls' })
    const order: string[] = []
    await Promise.all([kill.then(() => order.push('kill')), classify.then(() => order.push('classify'))])
    expect(order).toEqual(['classify', 'kill'])
    expect(await kill).toMatchObject({ killed: true })
    expect(await classify).toMatchObject({ sensitive: false })
    c.close()
  })

  it('maps bridge errors to TerminalError codes', async () => {
    const c = client()
    await c.connect()
    const error = await c
      .request({ type: 'kill', session: '00000000-0000-4000-8000-000000000000' })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TerminalError)
    expect(error).toMatchObject({ code: 'session_not_found' })
    c.close()
  })
})

function silentSocket(): SocketLike {
  return {
    readyState: 1,
    send: () => {},
    close: () => {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  }
}

function helloFrame(protocol: number): { data: string } {
  return {
    data: JSON.stringify({
      type: 'hello',
      protocol,
      bridgeVersion: '0.1.0',
      platform: 'darwin',
      rootName: 'x',
      rootFingerprint: 'y',
      capabilities: [],
    }),
  }
}

it('times out a request the bridge never answers, so a hung bridge cannot stall a tool call', async () => {
  const socket = silentSocket()
  socket.send = (data) => {
    const message = JSON.parse(data) as { type: string; id: string }
    if (message.type === 'hello') socket.onmessage?.({ data: JSON.stringify({ type: 'ok', id: message.id, result: {} }) })
  }
  const c = new BridgeClient({ url: 'ws://127.0.0.1:1', token: 'x', clientVersion: 't', socketFactory: () => socket })
  const connecting = c.connect()
  socket.onmessage?.(helloFrame(1))
  await connecting
  await expect(c.request({ type: 'list' }, 20)).rejects.toMatchObject({ code: 'timeout' })
})

it('rejects a bridge that speaks a different protocol version', async () => {
  const socket = silentSocket()
  const c = new BridgeClient({ url: 'ws://127.0.0.1:1', token: 'x', clientVersion: 't', socketFactory: () => socket })
  const connecting = c.connect()
  socket.onmessage?.(helloFrame(99))
  await expect(connecting).rejects.toBeInstanceOf(ProtocolMismatchError)
})
