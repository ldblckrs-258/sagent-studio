import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { checkUpgrade, isAllowedHost, isAllowedOrigin, redactToken } from './auth.js'
import type { BridgeConfig } from './config.js'
import { BridgeError } from './errors.js'
import { EXPIRED_PAGE, PAIR_HEADERS, PairCodes, pairRedirectLocation, pairUrl } from './pair.js'
import {
  PROTOCOL_VERSION,
  SUBPROTOCOL,
  isClientMessage,
  type BridgeMessage,
  type Capability,
  type ClientMessage,
  type HealthResponse,
} from './protocol.js'
import { BRIDGE_VERSION } from './protocol.js'

export const HELLO_TIMEOUT_MS = 5000
export const HEARTBEAT_MS = 30000
export const MAX_PAYLOAD = 1024 * 1024
export const BACKPRESSURE_BYTES = 1024 * 1024

export type RequestMessage = Exclude<ClientMessage, { type: 'hello' }>

export interface BridgeClient {
  readonly attached: Set<string>
  send(message: BridgeMessage): void
  sendLive(message: BridgeMessage): void
}

export interface RequestHandler {
  capabilities(): Capability[]
  handle(client: BridgeClient, message: RequestMessage): Promise<unknown>
  clientClosed(client: BridgeClient): void
  shutdown(): Promise<void>
}

export interface BridgeServer {
  readonly port: number
  mintPairUrl(): string
  broadcast(message: BridgeMessage, filter?: (client: BridgeClient) => boolean): void
  close(): Promise<void>
}

export type LogLevel = 'info' | 'ok' | 'warn' | 'error'

export interface ServerOptions {
  heartbeatMs?: number
  helloTimeoutMs?: number
  log?: (line: string, level?: LogLevel) => void
}

export type HandlerFactory = (server: Pick<BridgeServer, 'broadcast'>) => RequestHandler

class Client implements BridgeClient {
  readonly attached = new Set<string>()
  helloed = false
  alive = true
  private readonly ws: WebSocket
  private readonly token: string

  constructor(ws: WebSocket, token: string) {
    this.ws = ws
    this.token = token
  }

  send(message: BridgeMessage): void {
    if (this.ws.readyState !== this.ws.OPEN) return
    this.ws.send(redactToken(JSON.stringify(message), this.token))
  }

  sendLive(message: BridgeMessage): void {
    if (this.ws.bufferedAmount > BACKPRESSURE_BYTES) return
    this.send(message)
  }

  heartbeat(): void {
    if (!this.alive) {
      this.ws.terminate()
      return
    }
    this.alive = false
    this.ws.ping()
  }
}

function reject(socket: Duplex, status: 401 | 403): void {
  const text = status === 401 ? 'Unauthorized' : 'Forbidden'
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string>): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

export async function startServer(
  config: BridgeConfig,
  createHandler: HandlerFactory,
  options: ServerOptions = {},
): Promise<BridgeServer> {
  const log = options.log ?? (() => {})
  const pairCodes = new PairCodes()
  const clients = new Set<Client>()
  let port = config.port

  const broadcast = (message: BridgeMessage, filter?: (client: BridgeClient) => boolean): void => {
    for (const client of clients) {
      if (!client.helloed) continue
      if (filter && !filter(client)) continue
      if (message.type === 'output') client.sendLive(message)
      else client.send(message)
    }
  }

  const handler = createHandler({ broadcast })

  const helloMessage = (): BridgeMessage => ({
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    bridgeVersion: BRIDGE_VERSION,
    platform: process.platform,
    rootName: config.rootName,
    rootFingerprint: config.rootFingerprint,
    capabilities: handler.capabilities(),
  })

  const handleHttp = (req: IncomingMessage, res: ServerResponse): void => {
    if (!isAllowedHost(req.headers.host, port)) {
      res.writeHead(403).end()
      return
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    if (req.method === 'GET' && url.pathname === '/health') {
      const origin = req.headers.origin
      if (isAllowedOrigin(origin, config.allowedOrigins)) {
        const body: HealthResponse = {
          name: 'sagent-bridge',
          protocol: PROTOCOL_VERSION,
          bridgeVersion: BRIDGE_VERSION,
          rootName: config.rootName,
          allowed: true,
        }
        sendJson(res, 200, body, { 'Access-Control-Allow-Origin': origin as string, Vary: 'Origin' })
      } else {
        const body: HealthResponse = { name: 'sagent-bridge', protocol: PROTOCOL_VERSION, allowed: false }
        sendJson(res, 200, body, { 'Access-Control-Allow-Origin': '*' })
      }
      return
    }
    if (req.method === 'GET' && url.pathname === '/pair') {
      if (!pairCodes.consume(url.searchParams.get('code'))) {
        res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8', ...PAIR_HEADERS })
        res.end(EXPIRED_PAGE)
        return
      }
      const location = pairRedirectLocation(config.appUrl, `ws://127.0.0.1:${port}`, config.token)
      res.writeHead(302, { Location: location, ...PAIR_HEADERS })
      res.end()
      log('pair link used')
      return
    }
    res.writeHead(404).end()
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  })

  const http = createServer(handleHttp)

  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const verdict = checkUpgrade(
      { host: req.headers.host, origin: req.headers.origin, protocols: req.headers['sec-websocket-protocol'] },
      port,
      config.allowedOrigins,
      config.token,
    )
    if (!verdict.ok) {
      log(`rejected socket: ${verdict.reason}`, 'warn')
      reject(socket, verdict.status)
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (ws: WebSocket) => {
    const client = new Client(ws, config.token)
    clients.add(client)
    log(`client connected (${clients.size})`, 'ok')
    client.send(helloMessage())
    const helloTimer = setTimeout(() => {
      if (!client.helloed) ws.close(4001, 'hello timeout')
    }, options.helloTimeoutMs ?? HELLO_TIMEOUT_MS)

    ws.on('pong', () => {
      client.alive = true
    })

    ws.on('message', (raw, isBinary) => {
      let parsed: unknown
      try {
        parsed = isBinary ? undefined : JSON.parse(raw.toString())
      } catch {
        parsed = undefined
      }
      if (!isClientMessage(parsed)) {
        const id = typeof (parsed as { id?: unknown })?.id === 'string' ? (parsed as { id: string }).id : undefined
        client.send({ type: 'error', id, code: 'bad_request', message: 'Malformed message' })
        return
      }
      if (parsed.type === 'hello') {
        client.helloed = true
        clearTimeout(helloTimer)
        client.send({ type: 'ok', id: parsed.id, result: {} })
        return
      }
      if (!client.helloed) {
        client.send({ type: 'error', id: parsed.id, code: 'bad_request', message: 'Send hello first' })
        return
      }
      const message = parsed
      handler.handle(client, message).then(
        (result) => client.send({ type: 'ok', id: message.id, result: result ?? {} }),
        (error: unknown) => {
          if (error instanceof BridgeError) {
            client.send({ type: 'error', id: message.id, code: error.code, message: error.message })
          } else {
            log(`internal error: ${redactToken(String(error), config.token)}`, 'error')
            client.send({ type: 'error', id: message.id, code: 'internal', message: 'Internal bridge error' })
          }
        },
      )
    })

    ws.on('close', () => {
      clearTimeout(helloTimer)
      clients.delete(client)
      handler.clientClosed(client)
      log(`client disconnected (${clients.size})`)
    })

    ws.on('error', () => {})
  })

  const heartbeat = setInterval(() => {
    for (const client of clients) client.heartbeat()
  }, options.heartbeatMs ?? HEARTBEAT_MS)
  heartbeat.unref()

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    http.once('error', onError)
    http.listen(config.port, '127.0.0.1', () => {
      http.off('error', onError)
      resolve()
    })
  })
  const address = http.address()
  if (address && typeof address === 'object') port = address.port

  let closing: Promise<void> | null = null
  return {
    get port() {
      return port
    },
    mintPairUrl: () => pairUrl(port, pairCodes.mint()),
    broadcast,
    close: () => {
      closing ??= (async () => {
        clearInterval(heartbeat)
        await handler.shutdown()
        for (const ws of wss.clients) ws.close(1001, 'bridge stopping')
        for (const ws of wss.clients) ws.terminate()
        await new Promise<void>((resolve) => wss.close(() => resolve()))
        await new Promise<void>((resolve) => http.close(() => resolve()))
        http.closeAllConnections()
      })()
      return closing
    },
  }
}
