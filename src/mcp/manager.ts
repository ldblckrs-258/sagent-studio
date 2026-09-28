import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import type {
  CallToolResult,
  GetPromptResult,
  Implementation,
  Prompt,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { createStore } from 'zustand/vanilla'
import type { StoreApi } from 'zustand/vanilla'
import {
  McpNotReadyError,
  McpSessionClosedError,
  classifyMcpError,
  describeMcpError,
  httpStatusOf,
} from './errors'
import type { McpErrorKind } from './errors'
import { createMcpFetch } from './fetch'
import { mcpOAuthRedirectUrl, waitForMcpOAuthCallback } from './oauth-callback'
import type { WaitForCallbackOptions } from './oauth-callback'
import { VaultOAuthProvider } from './oauth-provider'
import { mcpServerStore } from './store'
import type { McpServerPersistence } from './store'
import { assertUniqueServers, serverSlug, validateMcpServerConfig } from './types'
import type { McpServerConfig } from './types'

export const MCP_CLIENT_INFO: Implementation = { name: 'sagent-studio', version: '0.0.0' }
export const MCP_LIST_MAX = 500
export const MCP_LIST_MAX_PAGES = 50
export const MCP_TERMINATE_GRACE_MS = 1_000

export type McpConnectionState = 'idle' | 'connecting' | 'ready' | 'needs-auth' | 'error'
export type McpConcreteTransport = 'streamable-http' | 'sse'
export type McpListKind = 'tools' | 'prompts' | 'resources' | 'resourceTemplates'

export interface McpCatalog {
  tools: Tool[]
  prompts: Prompt[]
  resources: Resource[]
  resourceTemplates: ResourceTemplate[]
  truncated: McpListKind[]
}

export interface McpSkippedTool {
  name: string
  reason: string
}

export interface McpServerView {
  config: McpServerConfig
  state: McpConnectionState
  reason?: string
  errorKind?: McpErrorKind
  serverInfo?: Implementation
  transport?: McpConcreteTransport
  catalog: McpCatalog
  skippedTools: McpSkippedTool[]
}

export interface McpStoreState {
  servers: Record<string, McpServerView>
  order: string[]
  loaded: boolean
  error: string | null
}

export interface McpTransportInit {
  fetch: FetchLike
  authProvider?: OAuthClientProvider
}

export type McpTransportFactory = (
  kind: McpConcreteTransport,
  url: URL,
  init: McpTransportInit,
) => Transport

export interface McpManagerOptions {
  persistence?: McpServerPersistence
  transportFactory?: McpTransportFactory
  baseFetch?: FetchLike
  authProviderFor?: (config: McpServerConfig) => OAuthClientProvider | undefined
  redirectUrl?: () => string
  openPopup?: () => McpPopup | null
  waitForCallback?: (options: WaitForCallbackOptions) => Promise<string>
  forgetToolDecisions?: (serverName: string) => void
}

export interface McpPopup {
  readonly closed: boolean
  close(): void
  navigate(url: URL): void
}

function openBrowserPopup(): McpPopup | null {
  const popup = window.open('about:blank', 'sagent-mcp-oauth', 'popup,width=520,height=720')
  if (!popup) return null
  popup.opener = null
  return {
    get closed() {
      return popup.closed
    },
    close: () => popup.close(),
    navigate: (url) => {
      popup.location.href = url.href
    },
  }
}

interface Connection {
  generation: number
  client: Client
  transport: Transport
  reconnected: boolean
}

export const emptyCatalog = (): McpCatalog => ({
  tools: [],
  prompts: [],
  resources: [],
  resourceTemplates: [],
  truncated: [],
})

export const defaultTransportFactory: McpTransportFactory = (kind, url, init) =>
  kind === 'sse'
    ? new SSEClientTransport(url, init)
    : new StreamableHTTPClientTransport(url, init)

function shouldFallBackToSse(error: unknown): boolean {
  const status = httpStatusOf(error)
  return status !== undefined && status >= 400 && status < 500 && status !== 401 && status !== 403
}

function credentialsBoundToChanged(before: McpServerConfig, after: McpServerConfig): boolean {
  if (before.auth.kind !== 'oauth') return false
  if (after.auth.kind !== 'oauth') return true
  return (
    before.url !== after.url ||
    before.proxyUrl !== after.proxyUrl ||
    before.auth.clientId !== after.auth.clientId ||
    before.auth.clientSecret !== after.auth.clientSecret
  )
}

function connectionFieldsChanged(before: McpServerConfig, after: McpServerConfig): boolean {
  return (
    before.url !== after.url ||
    before.transport !== after.transport ||
    before.proxyUrl !== after.proxyUrl ||
    before.timeoutMs !== after.timeoutMs ||
    before.enabled !== after.enabled ||
    JSON.stringify(before.auth) !== JSON.stringify(after.auth)
  )
}

async function collectPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < MCP_LIST_MAX_PAGES; page += 1) {
    const result = await fetchPage(cursor)
    items.push(...result.items)
    if (items.length >= MCP_LIST_MAX) return { items: items.slice(0, MCP_LIST_MAX), truncated: true }
    if (!result.nextCursor || seen.has(result.nextCursor)) return { items, truncated: false }
    seen.add(result.nextCursor)
    cursor = result.nextCursor
  }
  return { items, truncated: true }
}

function isMethodNotFound(error: unknown): boolean {
  return error instanceof McpError && error.code === ErrorCode.MethodNotFound
}

export class McpConnectionManager {
  readonly store: StoreApi<McpStoreState>
  private readonly persistence: McpServerPersistence
  private readonly transportFactory: McpTransportFactory
  private readonly baseFetch: FetchLike | undefined
  private readonly authProviderFor: (config: McpServerConfig) => OAuthClientProvider | undefined
  private readonly redirectUrl: () => string
  private readonly openPopup: () => McpPopup | null
  private readonly waitForCallback: (options: WaitForCallbackOptions) => Promise<string>
  private readonly forgetToolDecisions: (serverName: string) => void
  private readonly connections = new Map<string, Connection>()
  private readonly generations = new Map<string, number>()
  private readonly refreshSequences = new Map<string, number>()
  private disposed = false
  private epoch = 0

  constructor(options: McpManagerOptions = {}) {
    this.persistence = options.persistence ?? mcpServerStore
    this.transportFactory = options.transportFactory ?? defaultTransportFactory
    this.baseFetch = options.baseFetch
    this.redirectUrl = options.redirectUrl ?? (() => mcpOAuthRedirectUrl(window.location))
    this.authProviderFor =
      options.authProviderFor ??
      ((config) =>
        new VaultOAuthProvider({ config, persistence: this.persistence, redirectUrl: this.redirectUrl() }))
    this.openPopup = options.openPopup ?? openBrowserPopup
    this.waitForCallback = options.waitForCallback ?? waitForMcpOAuthCallback
    this.forgetToolDecisions = options.forgetToolDecisions ?? (() => undefined)
    this.store = createStore<McpStoreState>(() => ({
      servers: {},
      order: [],
      loaded: false,
      error: null,
    }))
  }

  isDisposed(): boolean {
    return this.disposed
  }

  revive(): void {
    if (!this.disposed) return
    this.disposed = false
    this.epoch += 1
  }

  view(id: string): McpServerView | undefined {
    return this.store.getState().servers[id]
  }

  views(): McpServerView[] {
    const { servers, order } = this.store.getState()
    return order.map((id) => servers[id]).filter((view): view is McpServerView => view !== undefined)
  }

  async hydrate(): Promise<void> {
    if (this.disposed) return
    const epoch = this.epoch
    try {
      const entries = await this.persistence.list()
      if (this.disposed || this.epoch !== epoch) return
      const servers: Record<string, McpServerView> = {}
      const configs = entries
        .map((entry) => entry.config)
        .sort((a, b) => a.name.localeCompare(b.name))
      for (const config of configs) {
        servers[config.id] = { config, state: 'idle', catalog: emptyCatalog(), skippedTools: [] }
      }
      this.store.setState({ servers, order: configs.map((config) => config.id), loaded: true, error: null })
      for (const config of configs) {
        if (config.enabled) void this.connect(config.id)
      }
    } catch (error) {
      if (this.disposed || this.epoch !== epoch) return
      this.store.setState({
        loaded: true,
        error: `MCP servers could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  async saveServer(input: McpServerConfig): Promise<McpServerView> {
    this.assertLive()
    const config = validateMcpServerConfig(input)
    const others = this.views()
      .map((view) => view.config)
      .filter((existing) => existing.id !== config.id)
    assertUniqueServers([...others, config])
    const previous = this.view(config.id)
    await this.persistence.save(config)
    if (previous && credentialsBoundToChanged(previous.config, config)) {
      await this.persistence.saveOAuth(config.id, () => ({}))
    }
    if (
      previous &&
      (previous.config.url !== config.url || serverSlug(previous.config.name) !== serverSlug(config.name))
    ) {
      this.forgetToolDecisions(previous.config.name)
    }
    this.assertLive()
    this.patch(config.id, {
      config,
      ...(previous ? {} : { state: 'idle', catalog: emptyCatalog(), skippedTools: [] }),
    })
    if (!previous) {
      const order = [...this.store.getState().order, config.id]
      this.store.setState({ order })
    }
    const needsReconnect = !previous || connectionFieldsChanged(previous.config, config)
    if (needsReconnect) {
      if (config.enabled) void this.connect(config.id)
      else await this.disconnect(config.id)
    }
    return this.view(config.id)!
  }

  async setToolEnabled(id: string, toolName: string, enabled: boolean): Promise<void> {
    const view = this.requireView(id)
    const disabled = new Set(view.config.disabledTools)
    if (enabled) disabled.delete(toolName)
    else disabled.add(toolName)
    await this.saveServer({ ...view.config, disabledTools: [...disabled] })
  }

  async removeServer(id: string): Promise<void> {
    this.assertLive()
    const name = this.view(id)?.config.name
    await this.disconnect(id)
    await this.persistence.remove(id)
    if (name !== undefined) this.forgetToolDecisions(name)
    const { servers, order } = this.store.getState()
    const rest = { ...servers }
    delete rest[id]
    this.store.setState({ servers: rest, order: order.filter((entry) => entry !== id) })
  }

  setSkippedTools(id: string, skippedTools: McpSkippedTool[]): void {
    const view = this.view(id)
    if (!view) return
    const same =
      view.skippedTools.length === skippedTools.length &&
      view.skippedTools.every(
        (entry, index) =>
          entry.name === skippedTools[index]?.name && entry.reason === skippedTools[index]?.reason,
      )
    if (!same) this.patch(id, { skippedTools })
  }

  async connect(id: string): Promise<void> {
    this.assertLive()
    const view = this.requireView(id)
    const generation = this.bumpGeneration(id)
    await this.closeConnection(id)
    this.patch(id, {
      state: 'connecting',
      reason: undefined,
      errorKind: undefined,
    })
    const config = view.config
    try {
      if (config.auth.kind === 'oauth' && !(await this.hasTokens(config.id))) {
        if (!this.isCurrent(id, generation)) return
        this.patch(id, {
          state: 'needs-auth',
          errorKind: 'unauthorized',
          reason: 'Sign in to this server to connect.',
        })
        return
      }
      const connection = await this.open(config, generation)
      if (!this.isCurrent(id, generation)) {
        await connection.client.close().catch(() => undefined)
        return
      }
      this.connections.set(id, connection)
      const catalog = await this.loadCatalog(connection.client)
      if (!this.isCurrent(id, generation)) return
      this.patch(id, {
        state: 'ready',
        serverInfo: connection.client.getServerVersion(),
        catalog,
      })
    } catch (error) {
      if (!this.isCurrent(id, generation)) return
      await this.closeConnection(id)
      this.fail(id, error)
    }
  }

  async disconnect(id: string): Promise<void> {
    this.bumpGeneration(id)
    await this.closeConnection(id, true)
    if (this.view(id)) {
      this.patch(id, {
        state: 'idle',
        reason: undefined,
        errorKind: undefined,
        catalog: emptyCatalog(),
        skippedTools: [],
      })
    }
  }

  async signIn(id: string): Promise<void> {
    this.assertLive()
    const view = this.requireView(id)
    if (view.config.auth.kind !== 'oauth') {
      throw new Error(`The MCP server "${view.config.name}" does not use OAuth.`)
    }
    const popup = this.openPopup()
    const config = view.config
    const generation = this.bumpGeneration(id)
    if (!popup) {
      this.patch(id, {
        state: 'needs-auth',
        errorKind: 'unauthorized',
        reason: 'The browser blocked the sign-in window. Allow pop-ups for this app and try again.',
      })
      return
    }
    await this.closeConnection(id)
    this.patch(id, { state: 'connecting', reason: 'Finish signing in in the pop-up window.', errorKind: undefined })
    const provider = new VaultOAuthProvider({
      config,
      persistence: this.persistence,
      redirectUrl: this.redirectUrl(),
      navigate: (url) => popup.navigate(url),
    })
    const fetchFn = createMcpFetch(config, this.baseFetch)
    const scope = config.auth.kind === 'oauth' ? config.auth.scopes : undefined
    try {
      const first = await auth(provider, { serverUrl: config.url, fetchFn, ...(scope ? { scope } : {}) })
      if (first === 'REDIRECT') {
        const expectedState = provider.pendingState()
        if (!expectedState) throw new Error('The sign-in request was built without a state value.')
        const code = await this.waitForCallback({ expectedState, isPopupClosed: () => popup.closed })
        if (!this.isCurrent(id, generation)) {
          if (!popup.closed) popup.close()
          return
        }
        await auth(provider, {
          serverUrl: config.url,
          authorizationCode: code,
          fetchFn,
          ...(scope ? { scope } : {}),
        })
      }
      if (!popup.closed) popup.close()
      if (!this.isCurrent(id, generation)) return
      await this.connect(id)
    } catch (error) {
      if (!popup.closed) popup.close()
      if (!this.isCurrent(id, generation)) return
      this.patch(id, {
        state: 'needs-auth',
        errorKind: 'unauthorized',
        reason: `Sign-in failed: ${describeMcpError(error)}`,
      })
    }
  }

  async signOut(id: string): Promise<void> {
    this.assertLive()
    const view = this.requireView(id)
    await this.persistence.saveOAuth(id, () => ({}))
    await this.disconnect(id)
    if (view.config.auth.kind === 'oauth' && view.config.enabled) {
      this.patch(id, { state: 'needs-auth', errorKind: 'unauthorized', reason: 'Signed out.' })
    }
  }

  async callTool(
    id: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    return this.request(id, (client, timeout) =>
      client.callTool({ name, arguments: args }, undefined, {
        timeout,
        ...(signal ? { signal } : {}),
      }) as Promise<CallToolResult>,
    )
  }

  async getPrompt(
    id: string,
    name: string,
    args: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<GetPromptResult> {
    return this.request(id, (client, timeout) =>
      client.getPrompt({ name, arguments: args }, { timeout, ...(signal ? { signal } : {}) }),
    )
  }

  async readResource(id: string, uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
    return this.request(id, (client, timeout) =>
      client.readResource({ uri }, { timeout, ...(signal ? { signal } : {}) }),
    )
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.epoch += 1
    const ids = [...this.connections.keys()]
    for (const id of this.generations.keys()) this.bumpGeneration(id)
    this.store.setState({ servers: {}, order: [], loaded: false, error: null })
    await Promise.all(ids.map((id) => this.closeConnection(id, true)))
  }

  private async request<T>(
    id: string,
    run: (client: Client, timeout: number) => Promise<T>,
  ): Promise<T> {
    this.assertLive()
    const view = this.requireView(id)
    const connection = this.connections.get(id)
    if (view.state !== 'ready' || !connection) throw new McpNotReadyError(view.config.name)
    try {
      return await run(connection.client, view.config.timeoutMs)
    } catch (error) {
      if (httpStatusOf(error) === 404 && connection.transport instanceof StreamableHTTPClientTransport) {
        await this.connect(id)
        const retry = this.connections.get(id)
        if (!retry || this.view(id)?.state !== 'ready') throw error
        return run(retry.client, view.config.timeoutMs)
      }
      const failure = classifyMcpError(error, view.config.auth)
      if (failure.kind === 'unauthorized' || failure.kind === 'network_or_cors') {
        if (this.connections.get(id) === connection) {
          this.bumpGeneration(id)
          await this.closeConnection(id)
          this.patch(id, { state: failure.state, reason: failure.reason, errorKind: failure.kind })
        }
      }
      throw error
    }
  }

  private async open(config: McpServerConfig, generation: number): Promise<Connection> {
    const kinds: McpConcreteTransport[] =
      config.transport === 'auto' ? ['streamable-http', 'sse'] : [config.transport]
    let lastError: unknown
    for (const [index, kind] of kinds.entries()) {
      const authProvider = config.auth.kind === 'oauth' ? this.authProviderFor(config) : undefined
      const transport = this.transportFactory(kind, new URL(config.url), {
        fetch: createMcpFetch(config, this.baseFetch),
        ...(authProvider ? { authProvider } : {}),
      })
      const client = this.createClient(config.id)
      try {
        await client.connect(transport, { timeout: config.timeoutMs })
        const connection: Connection = { generation, client, transport, reconnected: false }
        this.watchClose(config.id, connection)
        this.patch(config.id, { transport: kind })
        return connection
      } catch (error) {
        await client.close().catch(() => undefined)
        lastError = error
        const hasFallback = index < kinds.length - 1
        if (!hasFallback || !shouldFallBackToSse(error)) throw error
      }
    }
    throw lastError
  }

  private async hasTokens(id: string): Promise<boolean> {
    return (await this.persistence.get(id))?.oauth.tokens !== undefined
  }

  private createClient(id: string): Client {
    return new Client(MCP_CLIENT_INFO, {
      capabilities: {},
      listChanged: {
        tools: { autoRefresh: false, onChanged: () => void this.refreshList(id, 'tools') },
        prompts: { autoRefresh: false, onChanged: () => void this.refreshList(id, 'prompts') },
        resources: { autoRefresh: false, onChanged: () => void this.refreshList(id, 'resources') },
      },
    })
  }

  private watchClose(id: string, connection: Connection): void {
    const previous = connection.client.onclose
    connection.client.onclose = () => {
      previous?.()
      if (this.disposed) return
      if (this.connections.get(id) !== connection) return
      this.connections.delete(id)
      if (this.generations.get(id) !== connection.generation) return
      if (!connection.reconnected) {
        void this.reconnectOnce(id)
        return
      }
      this.patch(id, { state: 'error', errorKind: 'closed', reason: 'The connection to the server closed.' })
    }
  }

  private async reconnectOnce(id: string): Promise<void> {
    if (this.disposed || !this.view(id)) return
    await this.connect(id)
    const connection = this.connections.get(id)
    if (connection) connection.reconnected = true
  }

  private async loadCatalog(client: Client): Promise<McpCatalog> {
    const catalog = emptyCatalog()
    const capabilities = client.getServerCapabilities() ?? {}
    if (capabilities.tools) {
      const tools = await this.listTools(client)
      catalog.tools = tools.items
      if (tools.truncated) catalog.truncated.push('tools')
    }
    if (capabilities.prompts) {
      const prompts = await this.listPrompts(client)
      catalog.prompts = prompts.items
      if (prompts.truncated) catalog.truncated.push('prompts')
    }
    if (capabilities.resources) {
      const resources = await this.listResources(client)
      catalog.resources = resources.items
      if (resources.truncated) catalog.truncated.push('resources')
      const templates = await this.listResourceTemplates(client)
      catalog.resourceTemplates = templates.items
      if (templates.truncated) catalog.truncated.push('resourceTemplates')
    }
    return catalog
  }

  private listTools(client: Client) {
    return collectPages<Tool>(async (cursor) => {
      const result = await client.listTools(cursor ? { cursor } : undefined)
      return { items: result.tools, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) }
    })
  }

  private listPrompts(client: Client) {
    return collectPages<Prompt>(async (cursor) => {
      const result = await client.listPrompts(cursor ? { cursor } : undefined)
      return { items: result.prompts, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) }
    })
  }

  private listResources(client: Client) {
    return collectPages<Resource>(async (cursor) => {
      const result = await client.listResources(cursor ? { cursor } : undefined)
      return { items: result.resources, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) }
    })
  }

  private async listResourceTemplates(client: Client) {
    try {
      return await collectPages<ResourceTemplate>(async (cursor) => {
        const result = await client.listResourceTemplates(cursor ? { cursor } : undefined)
        return {
          items: result.resourceTemplates,
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        }
      })
    } catch (error) {
      if (isMethodNotFound(error)) return { items: [], truncated: false }
      throw error
    }
  }

  private async refreshList(id: string, kind: 'tools' | 'prompts' | 'resources'): Promise<void> {
    const connection = this.connections.get(id)
    const view = this.view(id)
    if (!connection || !view || view.state !== 'ready') return
    const key = `${id}:${kind}`
    const sequence = (this.refreshSequences.get(key) ?? 0) + 1
    this.refreshSequences.set(key, sequence)
    try {
      const updates: Partial<McpCatalog> = {}
      const refreshed: McpListKind[] = []
      const truncated: McpListKind[] = []
      if (kind === 'tools') {
        const tools = await this.listTools(connection.client)
        updates.tools = tools.items
        refreshed.push('tools')
        if (tools.truncated) truncated.push('tools')
      } else if (kind === 'prompts') {
        const prompts = await this.listPrompts(connection.client)
        updates.prompts = prompts.items
        refreshed.push('prompts')
        if (prompts.truncated) truncated.push('prompts')
      } else {
        const resources = await this.listResources(connection.client)
        const templates = await this.listResourceTemplates(connection.client)
        updates.resources = resources.items
        updates.resourceTemplates = templates.items
        refreshed.push('resources', 'resourceTemplates')
        if (resources.truncated) truncated.push('resources')
        if (templates.truncated) truncated.push('resourceTemplates')
      }
      if (this.connections.get(id) !== connection || this.refreshSequences.get(key) !== sequence) return
      const current = this.view(id)
      if (!current) return
      this.patch(id, {
        catalog: {
          ...current.catalog,
          ...updates,
          truncated: [
            ...current.catalog.truncated.filter((entry) => !refreshed.includes(entry)),
            ...truncated,
          ],
        },
      })
    } catch (error) {
      if (this.connections.get(id) !== connection || this.refreshSequences.get(key) !== sequence) return
      const failure = classifyMcpError(error, view.config.auth)
      this.patch(id, { reason: `Refreshing ${kind} failed: ${failure.reason}` })
    }
  }

  private async closeConnection(id: string, terminate = false): Promise<void> {
    const connection = this.connections.get(id)
    if (!connection) return
    this.connections.delete(id)
    if (terminate && connection.transport instanceof StreamableHTTPClientTransport) {
      const grace = new Promise<void>((resolve) => setTimeout(resolve, MCP_TERMINATE_GRACE_MS))
      await Promise.race([connection.transport.terminateSession().catch(() => undefined), grace])
    }
    await connection.client.close().catch(() => undefined)
  }

  private fail(id: string, error: unknown): void {
    const view = this.view(id)
    if (!view) return
    const failure = classifyMcpError(error, view.config.auth)
    this.patch(id, {
      state: failure.state,
      reason: failure.reason,
      errorKind: failure.kind,
      catalog: emptyCatalog(),
    })
  }

  private patch(id: string, patch: Partial<McpServerView>): void {
    const { servers } = this.store.getState()
    const current = servers[id]
    if (!current && !patch.config) return
    const next = { ...(current ?? {}), ...patch } as McpServerView
    for (const key of Object.keys(patch) as (keyof McpServerView)[]) {
      if (patch[key] === undefined) delete next[key]
    }
    this.store.setState({ servers: { ...servers, [id]: next } })
  }

  private bumpGeneration(id: string): number {
    const next = (this.generations.get(id) ?? 0) + 1
    this.generations.set(id, next)
    return next
  }

  private isCurrent(id: string, generation: number): boolean {
    return !this.disposed && this.generations.get(id) === generation && this.view(id) !== undefined
  }

  private requireView(id: string): McpServerView {
    const view = this.view(id)
    if (!view) throw new McpNotReadyError(id)
    return view
  }

  private assertLive(): void {
    if (this.disposed) throw new McpSessionClosedError()
  }
}
