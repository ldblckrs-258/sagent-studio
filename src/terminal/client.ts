import {
  PROTOCOL_VERSION,
  SUBPROTOCOL,
  TOKEN_SUBPROTOCOL_PREFIX,
  isBridgeMessage,
  type BridgeMessage,
  type ClientMessage,
} from 'sagent-bridge/protocol'
import { TerminalError } from './types'

export interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason?: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export type SocketFactory = (url: string, protocols: string[]) => SocketLike

export const browserSocketFactory: SocketFactory = (url, protocols) =>
  new WebSocket(url, protocols) as unknown as SocketLike

export type HelloMessage = Extract<BridgeMessage, { type: 'hello' }>
export type PushMessage = Extract<BridgeMessage, { type: 'output' | 'exit' | 'sessions' }>

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
export type RequestBody = WithoutId<ClientMessage>

export const DEFAULT_REQUEST_TIMEOUT_MS = 5000
export const HELLO_TIMEOUT_MS = 5000
const OPEN = 1

export class ProtocolMismatchError extends Error {
  readonly bridgeProtocol: number

  constructor(bridgeProtocol: number) {
    super(`The bridge speaks protocol ${bridgeProtocol}; this app needs ${PROTOCOL_VERSION}.`)
    this.name = 'ProtocolMismatchError'
    this.bridgeProtocol = bridgeProtocol
  }
}

export class SocketClosedError extends Error {
  readonly code: number

  constructor(code: number) {
    super(`The bridge connection closed (${code}).`)
    this.name = 'SocketClosedError'
    this.code = code
  }
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export interface BridgeClientOptions {
  url: string
  token: string
  clientVersion: string
  socketFactory?: SocketFactory
  onPush?(message: PushMessage): void
  onClose?(code: number): void
}

export class BridgeClient {
  private socket: SocketLike | null = null
  private readonly pending = new Map<string, Pending>()
  private counter = 0
  private closed = false
  private readonly options: BridgeClientOptions

  constructor(options: BridgeClientOptions) {
    this.options = options
  }

  get isOpen(): boolean {
    return !this.closed && this.socket?.readyState === OPEN
  }

  connect(): Promise<HelloMessage> {
    const factory = this.options.socketFactory ?? browserSocketFactory
    return new Promise<HelloMessage>((resolve, reject) => {
      let settled = false
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.close()
        reject(error)
      }
      const timer = setTimeout(() => fail(new Error('The bridge did not answer in time.')), HELLO_TIMEOUT_MS)
      let socket: SocketLike
      try {
        socket = factory(this.options.url, [SUBPROTOCOL, `${TOKEN_SUBPROTOCOL_PREFIX}${this.options.token}`])
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
        return
      }
      this.socket = socket
      socket.onerror = () => {}
      socket.onclose = (event) => {
        this.closed = true
        this.rejectAll(new SocketClosedError(event.code))
        if (!settled) fail(new SocketClosedError(event.code))
        else this.options.onClose?.(event.code)
      }
      socket.onmessage = (event) => {
        let parsed: unknown
        try {
          parsed = typeof event.data === 'string' ? JSON.parse(event.data) : undefined
        } catch {
          return
        }
        if (!isBridgeMessage(parsed)) return
        if (parsed.type === 'hello') {
          if (settled) return
          if (parsed.protocol !== PROTOCOL_VERSION) {
            fail(new ProtocolMismatchError(parsed.protocol))
            return
          }
          const hello = parsed
          this.request({ type: 'hello', clientVersion: this.options.clientVersion }).then(
            () => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              resolve(hello)
            },
            (error: Error) => fail(error),
          )
          return
        }
        if (parsed.type === 'ok' || parsed.type === 'error') {
          const id = parsed.id
          if (id === undefined) return
          const entry = this.pending.get(id)
          if (!entry) return
          this.pending.delete(id)
          clearTimeout(entry.timer)
          if (parsed.type === 'ok') entry.resolve(parsed.result)
          else entry.reject(new TerminalError(parsed.code, parsed.message))
          return
        }
        this.options.onPush?.(parsed)
      }
    })
  }

  request<T>(body: RequestBody, timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    const socket = this.socket
    if (!socket || this.closed || socket.readyState !== OPEN) {
      return Promise.reject(new TerminalError('unavailable', 'The bridge is not connected.'))
    }
    const id = `c${++this.counter}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new TerminalError('timeout', 'The bridge did not answer in time.'))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      socket.send(JSON.stringify({ ...body, id }))
    })
  }

  private rejectAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error instanceof SocketClosedError ? new TerminalError('unavailable', error.message) : error)
      this.pending.delete(id)
    }
  }

  close(): void {
    if (this.closed && !this.socket) return
    this.closed = true
    const socket = this.socket
    this.socket = null
    this.rejectAll(new TerminalError('unavailable', 'The bridge connection was closed.'))
    if (socket) {
      socket.onclose = null
      socket.onmessage = null
      try {
        socket.close(1000, 'client closing')
      } catch {
        return
      }
    }
  }
}
