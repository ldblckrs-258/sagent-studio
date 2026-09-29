import {
  BRIDGE_VERSION,
  DEFAULT_APP_URL,
  PROTOCOL_VERSION,
  decodeBase64,
  type Classification,
  type HealthResponse,
  type InputKey,
  type InputOrigin,
  type KillOwnedResult,
  type KillResult,
  type ReadResult,
  type SessionInfo,
  type VerifyRootResult,
} from 'sagent-bridge/protocol'
import type { Settings } from '../vault/settings'
import {
  BridgeClient,
  ProtocolMismatchError,
  type PushMessage,
  type RequestBody,
  type SocketFactory,
} from './client'
import { takePendingPair } from './pairing'
import { createRootBinding, type RootBinding } from './root-binding'
import {
  TerminalError,
  type BindResult,
  type BridgeConfig,
  type BridgeStatus,
  type BridgeView,
  type CreateSessionRequest,
  type OutputListener,
  type ReadRequest,
  type TerminalPort,
} from './types'

export const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000]
export const MAX_RECONNECT_ATTEMPTS = 10
export const KILL_TIMEOUT_MS = 15000
export const HEALTH_TIMEOUT_MS = 2000

export function bridgeStartCommand(appOrigin: string | undefined): string {
  const base = `npx sagent-bridge@${BRIDGE_VERSION} --root <your project folder>`
  if (!appOrigin || appOrigin === new URL(DEFAULT_APP_URL).origin) return base
  return `${base} --app-url ${appOrigin}`
}

export const START_COMMAND = bridgeStartCommand(globalThis.location?.origin)

export interface TerminalManagerDeps {
  getSettings(): Settings | null
  saveConfig(config: BridgeConfig | null): Promise<void>
  handleFor(threadId: string): Promise<FileSystemDirectoryHandle | null>
  socketFactory?: SocketFactory
  fetch?: typeof fetch
  queryLoopbackPermission?(): Promise<PermissionState | null>
  takePendingPair?(): BridgeConfig | null
  appOrigin?(): string
  backoffMs?: readonly number[]
  maxAttempts?: number
}

interface Diagnosis {
  status: BridgeStatus
  reason: string
  retry: boolean
}

interface ListenerEntry {
  fn: OutputListener
  offset: number
  ready: boolean
  queue: { bytes: Uint8Array; offset: number }[]
}

async function defaultLoopbackPermission(): Promise<PermissionState | null> {
  try {
    const status = await navigator.permissions.query({ name: 'loopback-network' as PermissionName })
    return status.state
  } catch {
    return null
  }
}

function httpBase(wsUrl: string): string {
  const url = new URL(wsUrl)
  url.protocol = 'http:'
  return url.origin
}

function deliver(entry: ListenerEntry, bytes: Uint8Array, offset: number): void {
  const end = offset + bytes.length
  if (end <= entry.offset) return
  const slice = offset < entry.offset ? bytes.subarray(entry.offset - offset) : bytes
  const from = Math.max(offset, entry.offset)
  entry.offset = end
  entry.fn(slice, from)
}

export class TerminalManager implements TerminalPort {
  private readonly deps: TerminalManagerDeps
  private readonly listeners = new Set<() => void>()
  private readonly subscriptions = new Map<string, Set<ListenerEntry>>()
  private readonly binding: RootBinding
  private state: BridgeView = { status: 'unpaired', capabilities: [], sessions: [], paired: false }
  private client: BridgeClient | null = null
  private config: BridgeConfig | null = null
  private epochCount = 0
  private generation = 0
  private attempts = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private active = false

  constructor(deps: TerminalManagerDeps) {
    this.deps = deps
    this.binding = createRootBinding({
      handleFor: (threadId) => deps.handleFor(threadId),
      verify: async (nonce) =>
        (await this.request<VerifyRootResult>({ type: 'verifyRoot', nonce })).matches === true,
      epoch: () => this.epochCount,
      connected: () => this.state.status === 'ready' && this.client?.isOpen === true,
    })
  }

  view(): BridgeView {
    return this.state
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  sessions(): SessionInfo[] {
    return this.state.sessions
  }

  epoch(): number {
    return this.epochCount
  }

  private storedConfig(): BridgeConfig | null {
    return this.deps.getSettings()?.terminal ?? null
  }

  private setState(patch: Partial<BridgeView>): void {
    this.state = {
      ...this.state,
      ...patch,
      paired: this.config !== null || this.storedConfig() !== null,
    }
    for (const listener of [...this.listeners]) listener()
  }

  revive(): void {
    this.active = true
    this.attempts = 0
    const pending = (this.deps.takePendingPair ?? takePendingPair)()
    if (pending) {
      void this.connect(pending, true)
      return
    }
    const stored = this.storedConfig()
    if (stored) void this.connect(stored, false)
    else this.setState({ status: 'unpaired', reason: undefined })
  }

  pair(config: BridgeConfig): Promise<boolean> {
    this.active = true
    this.attempts = 0
    return this.connect(config, true)
  }

  retry(): void {
    if (!this.active) return
    this.attempts = 0
    const config = this.config ?? this.storedConfig()
    if (config) void this.connect(config, false)
  }

  async forget(): Promise<void> {
    this.generation++
    this.clearRetry()
    this.client?.close()
    this.client = null
    this.config = null
    await this.deps.saveConfig(null)
    this.setState({ status: 'unpaired', reason: undefined, sessions: [], capabilities: [] })
  }

  dispose(): void {
    this.active = false
    this.generation++
    this.clearRetry()
    this.client?.close()
    this.client = null
    this.config = null
    this.subscriptions.clear()
    this.binding.reset()
    this.state = { status: 'unpaired', capabilities: [], sessions: [], paired: false }
    for (const listener of [...this.listeners]) listener()
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private async connect(config: BridgeConfig, persist: boolean): Promise<boolean> {
    const generation = ++this.generation
    this.clearRetry()
    this.client?.close()
    this.client = null
    this.setState({ status: 'connecting', reason: undefined })
    const client = new BridgeClient({
      url: config.url,
      token: config.token,
      clientVersion: BRIDGE_VERSION,
      socketFactory: this.deps.socketFactory,
      onPush: (message) => this.onPush(message),
      onClose: () => this.lost(generation),
    })
    this.client = client
    try {
      const hello = await client.connect()
      if (generation !== this.generation) {
        client.close()
        return false
      }
      this.config = config
      this.epochCount++
      this.binding.reset()
      this.attempts = 0
      if (persist) {
        try {
          await this.deps.saveConfig(config)
        } catch (error) {
          this.config = null
          client.close()
          throw error
        }
      }
      const { sessions } = await client.request<{ sessions: SessionInfo[] }>({ type: 'list' })
      if (generation !== this.generation) return false
      this.setState({
        status: 'ready',
        reason: undefined,
        bridgeVersion: hello.bridgeVersion,
        rootName: hello.rootName,
        platform: hello.platform,
        capabilities: hello.capabilities,
        sessions,
      })
      this.resubscribeAll()
      return true
    } catch (error) {
      if (generation !== this.generation) return false
      this.client = null
      const diagnosis = await this.diagnose(config, error)
      if (generation !== this.generation) return false
      this.setState({ status: diagnosis.status, reason: diagnosis.reason })
      if (!persist && diagnosis.retry) this.scheduleReconnect(config)
      return false
    }
  }

  private lost(generation: number): void {
    if (generation !== this.generation || !this.active) return
    this.client = null
    this.setState({ status: 'connecting', reason: 'Reconnecting to the bridge…' })
    const config = this.config ?? this.storedConfig()
    if (config) this.scheduleReconnect(config)
  }

  private scheduleReconnect(config: BridgeConfig): void {
    if (!this.active) return
    this.attempts++
    const max = this.deps.maxAttempts ?? MAX_RECONNECT_ATTEMPTS
    if (this.attempts > max) return
    const backoff = this.deps.backoffMs ?? RECONNECT_BACKOFF_MS
    const delay = backoff[Math.min(this.attempts - 1, backoff.length - 1)]
    const generation = this.generation
    this.clearRetry()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (generation !== this.generation || !this.active) return
      void this.connect(config, false)
    }, delay)
  }

  private async diagnose(config: BridgeConfig, error: unknown): Promise<Diagnosis> {
    if (error instanceof ProtocolMismatchError) {
      return { status: 'error', reason: `Update the bridge: ${START_COMMAND}`, retry: false }
    }
    const permission = await (this.deps.queryLoopbackPermission ?? defaultLoopbackPermission)()
    if (permission === 'denied') {
      return { status: 'error', reason: 'Allow local network access for this site in the browser settings.', retry: false }
    }
    const fetchImpl = this.deps.fetch ?? fetch
    let health: HealthResponse
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
      try {
        const response = await fetchImpl(`${httpBase(config.url)}/health`, { signal: controller.signal })
        health = (await response.json()) as HealthResponse
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return { status: 'error', reason: `Bridge not running: ${START_COMMAND}`, retry: true }
    }
    if (health.allowed === false) {
      const origin = this.deps.appOrigin?.() ?? (typeof location !== 'undefined' ? location.origin : '')
      return { status: 'error', reason: `Start the bridge with --app-url ${origin}`, retry: false }
    }
    if (health.protocol !== PROTOCOL_VERSION) {
      return { status: 'error', reason: `Update the bridge: ${START_COMMAND}`, retry: false }
    }
    return {
      status: 'needs-auth',
      reason: 'Pairing expired — press Enter in the bridge terminal and open the new link.',
      retry: false,
    }
  }

  private onPush(message: PushMessage): void {
    if (message.type === 'output') {
      const entries = this.subscriptions.get(message.session)
      if (!entries) return
      const bytes = decodeBase64(message.data)
      for (const entry of entries) {
        if (entry.ready) deliver(entry, bytes, message.offset)
        else entry.queue.push({ bytes, offset: message.offset })
      }
      return
    }
    if (message.type === 'sessions') {
      this.setState({ sessions: message.sessions })
      return
    }
    const sessions = this.state.sessions.map((session) =>
      session.id === message.session
        ? {
            ...session,
            running: false,
            exitCode: message.exitCode,
            signal: message.signal ?? null,
            ...(message.timedOut ? { timedOut: true } : {}),
          }
        : session,
    )
    this.setState({ sessions })
  }

  private request<T>(body: RequestBody, timeoutMs?: number): Promise<T> {
    const client = this.client
    if (!client || !client.isOpen || this.state.status !== 'ready') {
      return Promise.reject(new TerminalError('unavailable', 'The terminal bridge is not connected.'))
    }
    return client.request<T>(body, timeoutMs)
  }

  ensureBound(threadId: string): Promise<BindResult> {
    return this.binding.ensureBound(threadId)
  }

  create(request: CreateSessionRequest): Promise<SessionInfo> {
    return this.request<SessionInfo>({ type: 'create', ...request })
  }

  async input(session: string, data: string, origin: InputOrigin, expectVersion?: number): Promise<void> {
    await this.request({
      type: 'input',
      session,
      data,
      origin,
      ...(expectVersion !== undefined ? { expectVersion } : {}),
    })
  }

  async resize(session: string, cols: number, rows: number): Promise<void> {
    await this.request({ type: 'resize', session, cols, rows })
  }

  read(session: string, request: ReadRequest): Promise<ReadResult> {
    return this.request<ReadResult>({ type: 'read', session, ...request })
  }

  kill(session: string): Promise<KillResult> {
    return this.request<KillResult>({ type: 'kill', session }, KILL_TIMEOUT_MS)
  }

  async killOwned(filter: { threadId?: string; runId?: string }): Promise<string[]> {
    if (filter.threadId === undefined && filter.runId === undefined) return []
    const result = await this.request<KillOwnedResult>({ type: 'killOwned', ...filter }, KILL_TIMEOUT_MS)
    return result.killed
  }

  async list(): Promise<SessionInfo[]> {
    const { sessions } = await this.request<{ sessions: SessionInfo[] }>({ type: 'list' })
    this.setState({ sessions })
    return sessions
  }

  classify(command: string): Promise<Classification> {
    return this.request<Classification>({ type: 'classify', command })
  }

  classifyInput(
    session: string,
    input: string | undefined,
    keys: InputKey[] | undefined,
    submit: boolean,
  ): Promise<Classification> {
    return this.request<Classification>({
      type: 'classifyInput',
      session,
      submit,
      ...(input !== undefined ? { input } : {}),
      ...(keys !== undefined ? { keys } : {}),
    })
  }

  subscribe(session: string, onOutput: OutputListener, sinceOffset = 0): () => void {
    const entry: ListenerEntry = { fn: onOutput, offset: sinceOffset, ready: false, queue: [] }
    let entries = this.subscriptions.get(session)
    const first = !entries
    if (!entries) {
      entries = new Set()
      this.subscriptions.set(session, entries)
    }
    entries.add(entry)
    void this.replay(session, entry, first)
    return () => {
      const current = this.subscriptions.get(session)
      if (!current) return
      current.delete(entry)
      if (current.size === 0) {
        this.subscriptions.delete(session)
        this.request({ type: 'detach', session }).catch(() => undefined)
      }
    }
  }

  private async replay(session: string, entry: ListenerEntry, attach: boolean): Promise<void> {
    const result = await (attach
      ? this.request<ReadResult>({ type: 'attach', session, sinceOffset: entry.offset })
      : this.request<ReadResult>({
          type: 'read',
          session,
          sinceOffset: entry.offset,
          format: 'raw',
          maxBytes: 1024 * 1024,
        })
    ).catch(() => null)
    if (result) {
      if (result.fromOffset > entry.offset) entry.offset = result.fromOffset
      deliver(entry, decodeBase64(result.data), result.fromOffset)
    }
    entry.ready = true
    for (const chunk of entry.queue.splice(0)) deliver(entry, chunk.bytes, chunk.offset)
  }

  private resubscribeAll(): void {
    for (const [session, entries] of this.subscriptions) {
      let first = true
      for (const entry of entries) {
        entry.ready = false
        void this.replay(session, entry, first)
        first = false
      }
    }
  }

  redact(text: string): string {
    let out = text
    for (const token of [this.config?.token, this.storedConfig()?.token]) {
      if (token) out = out.split(token).join('[redacted]')
    }
    return out
  }
}
