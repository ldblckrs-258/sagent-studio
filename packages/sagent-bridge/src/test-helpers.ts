import { WebSocket } from 'ws'
import { deriveOrigins, type BridgeConfig } from './config.js'
import { SUBPROTOCOL, TOKEN_SUBPROTOCOL_PREFIX, type BridgeMessage } from './protocol.js'

export const TEST_TOKEN = 'test_token_0123456789abcdef'
export const TEST_ORIGIN = 'http://localhost:5173'

export function testConfig(root: string, overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    root,
    rootName: 'root',
    rootFingerprint: 'fp',
    port: 0,
    appUrl: 'http://localhost:5173/',
    allowedOrigins: deriveOrigins('http://localhost:5173', []),
    token: TEST_TOKEN,
    open: false,
    ...overrides,
  }
}

export interface TestSocket {
  ws: WebSocket
  messages: BridgeMessage[]
  next(predicate: (message: BridgeMessage) => boolean, timeoutMs?: number): Promise<BridgeMessage>
  request(message: Record<string, unknown>): Promise<BridgeMessage>
  close(): Promise<void>
}

export function openSocket(
  port: number,
  options: { origin?: string; token?: string; protocols?: string[]; host?: string } = {},
): Promise<TestSocket> {
  const protocols = options.protocols ?? [SUBPROTOCOL, `${TOKEN_SUBPROTOCOL_PREFIX}${options.token ?? TEST_TOKEN}`]
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, protocols, {
    origin: options.origin ?? TEST_ORIGIN,
    headers: options.host ? { Host: options.host } : undefined,
  })
  const messages: BridgeMessage[] = []
  const waiters: { predicate: (m: BridgeMessage) => boolean; resolve: (m: BridgeMessage) => void }[] = []
  let counter = 0
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as BridgeMessage
    messages.push(message)
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(message)
      }
    }
  })
  const next = (predicate: (m: BridgeMessage) => boolean, timeoutMs = 5000): Promise<BridgeMessage> => {
    const existing = messages.find(predicate)
    if (existing) {
      messages.splice(messages.indexOf(existing), 1)
      return Promise.resolve(existing)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs)
      waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer)
          messages.splice(messages.indexOf(m), 1)
          resolve(m)
        },
      })
    })
  }
  const socket: TestSocket = {
    ws,
    messages,
    next,
    request: (message) => {
      const id = `r${++counter}`
      ws.send(JSON.stringify({ ...message, id }))
      return next((m) => (m.type === 'ok' || m.type === 'error') && m.id === id)
    },
    close: () =>
      new Promise((resolve) => {
        if (ws.readyState === ws.CLOSED) return resolve()
        ws.once('close', () => resolve())
        ws.close()
      }),
  }
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(socket))
    ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error('rejected'), { status: res.statusCode })))
    ws.once('error', reject)
  })
}

export async function openHelloedSocket(port: number): Promise<TestSocket> {
  const socket = await openSocket(port)
  await socket.next((m) => m.type === 'hello')
  const ack = await socket.request({ type: 'hello', clientVersion: 'test' })
  if (ack.type !== 'ok') throw new Error('hello rejected')
  return socket
}
