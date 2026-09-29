import { afterEach, describe, expect, it } from 'vitest'
import { BridgeError } from './errors.js'
import { startServer, type BridgeServer, type RequestHandler } from './server.js'
import { openHelloedSocket, openSocket, TEST_ORIGIN, TEST_TOKEN, testConfig } from './test-helpers.js'

let server: BridgeServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

const stubHandler = (): RequestHandler => ({
  capabilities: () => ['exec'],
  handle: async (_client, message) => {
    if (message.type === 'list') return { sessions: [] }
    throw new BridgeError('bad_request', `unsupported ${message.type}`)
  },
  clientClosed: () => {},
  shutdown: async () => {},
})

async function start(options: Parameters<typeof startServer>[2] = {}): Promise<BridgeServer> {
  server = await startServer(testConfig('/tmp'), stubHandler, options)
  return server
}

describe('websocket upgrade guard', () => {
  it('lets a correct host, origin and token connect and receive hello', async () => {
    const { port } = await start()
    const socket = await openSocket(port)
    const hello = await socket.next((m) => m.type === 'hello')
    expect(hello).toMatchObject({ type: 'hello', protocol: 1, rootName: 'root', capabilities: ['exec'] })
    expect(socket.ws.protocol).toBe('sagent-bridge.v1')
    await socket.close()
  })

  it('rejects a wrong token with 401 before any session could exist', async () => {
    const { port } = await start()
    await expect(openSocket(port, { token: 'wrong_token_0123456789abcd' })).rejects.toMatchObject({ status: 401 })
  })

  it('rejects a DNS-rebinding Host with 403', async () => {
    const { port } = await start()
    await expect(openSocket(port, { host: `evil.com:${port}` })).rejects.toMatchObject({ status: 403 })
  })

  it('rejects a foreign Origin with 403', async () => {
    const { port } = await start()
    await expect(openSocket(port, { origin: 'https://evil.com' })).rejects.toMatchObject({ status: 403 })
  })

  it('rejects a missing Origin, with no test-mode exception', async () => {
    const { port } = await start()
    await expect(openSocket(port, { origin: '' })).rejects.toMatchObject({ status: 403 })
  })
})

describe('message handling', () => {
  it('refuses requests before the client hello', async () => {
    const { port } = await start()
    const socket = await openSocket(port)
    const reply = await socket.request({ type: 'list' })
    expect(reply).toMatchObject({ type: 'error', code: 'bad_request' })
    await socket.close()
  })

  it('routes requests after hello and maps handler errors to error frames', async () => {
    const { port } = await start()
    const socket = await openHelloedSocket(port)
    expect(await socket.request({ type: 'list' })).toMatchObject({ type: 'ok', result: { sessions: [] } })
    expect(await socket.request({ type: 'classify', command: 'ls' })).toMatchObject({
      type: 'error',
      code: 'bad_request',
    })
    await socket.close()
  })

  it('answers a malformed frame with bad_request and keeps the socket open', async () => {
    const { port } = await start()
    const socket = await openHelloedSocket(port)
    socket.ws.send('not json')
    expect(await socket.next((m) => m.type === 'error')).toMatchObject({ code: 'bad_request' })
    expect(await socket.request({ type: 'list' })).toMatchObject({ type: 'ok' })
    await socket.close()
  })

  it('closes with 4001 when the client never says hello', async () => {
    const { port } = await start({ helloTimeoutMs: 100 })
    const socket = await openSocket(port)
    const code = await new Promise<number>((resolve) => socket.ws.once('close', (c) => resolve(c)))
    expect(code).toBe(4001)
  })
})

describe('http endpoints', () => {
  it('/health tells an allowed origin who it is, with CORS for that origin', async () => {
    const { port } = await start()
    const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: TEST_ORIGIN } })
    expect(res.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN)
    expect(await res.json()).toMatchObject({ name: 'sagent-bridge', allowed: true, rootName: 'root' })
  })

  it('/health reveals no folder name to a foreign origin', async () => {
    const { port } = await start()
    const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: 'https://evil.com' } })
    const body = await res.json()
    expect(body).toEqual({ name: 'sagent-bridge', protocol: 1, allowed: false })
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('/pair redirects once with the token in the fragment, then returns 410', async () => {
    const srv = await start()
    const link = srv.mintPairUrl()
    const first = await fetch(link, { redirect: 'manual' })
    expect(first.status).toBe(302)
    expect(first.headers.get('cache-control')).toBe('no-store')
    expect(first.headers.get('referrer-policy')).toBe('no-referrer')
    const location = new URL(first.headers.get('location') as string)
    expect(location.search).toBe('')
    const fragment = new URLSearchParams(location.hash.slice(1))
    expect(fragment.get('token')).toBe(TEST_TOKEN)
    expect(fragment.get('sagent-bridge')).toBe(`ws://127.0.0.1:${srv.port}`)
    const second = await fetch(link, { redirect: 'manual' })
    expect(second.status).toBe(410)
    expect(await second.text()).toContain('Link expired')
  })

  it('pair links contain a code and never the token', async () => {
    const srv = await start()
    expect(srv.mintPairUrl()).not.toContain(TEST_TOKEN)
  })
})
