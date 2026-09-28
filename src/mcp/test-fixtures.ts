import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { McpServerPersistence } from './store'
import type { McpOAuthState, McpServerConfig, McpServerEntry } from './types'
import type { McpTransportFactory } from './manager'

export function memoryPersistence(initial: McpServerConfig[] = []): McpServerPersistence & {
  entries: Map<string, McpServerEntry>
} {
  const entries = new Map<string, McpServerEntry>(
    initial.map((config) => [config.id, { config, oauth: {} }]),
  )
  return {
    entries,
    list: async () => [...entries.values()].map((entry) => structuredClone(entry)),
    get: async (id) => {
      const entry = entries.get(id)
      return entry ? structuredClone(entry) : undefined
    },
    save: async (config) => {
      entries.set(config.id, { config: structuredClone(config), oauth: entries.get(config.id)?.oauth ?? {} })
    },
    saveOAuth: async (id, update: (current: McpOAuthState) => McpOAuthState) => {
      const entry = entries.get(id)
      if (!entry) throw new Error(`missing ${id}`)
      entries.set(id, { config: entry.config, oauth: update(entry.oauth) })
    },
    remove: async (id) => {
      entries.delete(id)
    },
  }
}

export function serverConfig(patch: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'mcp_one',
    name: 'Local',
    url: 'https://mcp.example.com/mcp',
    transport: 'streamable-http',
    auth: { kind: 'none' },
    enabled: true,
    disabledTools: [],
    timeoutMs: 5_000,
    ...patch,
  }
}

export interface InMemoryHarness<T extends { server: Server }> {
  factory: McpTransportFactory
  servers: T[]
  serverTransports: InMemoryTransport[]
  connects: number
}

export function inMemoryHarness<T extends { server: Server }>(build: () => T): InMemoryHarness<T> {
  const harness: InMemoryHarness<T> = {
    servers: [],
    serverTransports: [],
    connects: 0,
    factory: () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
      const built = build()
      harness.servers.push(built)
      harness.serverTransports.push(serverSide)
      harness.connects += 1
      void built.server.connect(serverSide)
      return clientSide
    },
  }
  return harness
}
