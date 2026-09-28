import Dexie from 'dexie'
import { beforeEach, describe, expect, it } from 'vitest'
import { deriveKey, randomBytes } from '../vault/crypto'
import { VaultDatabase, db } from '../vault/db'
import { CorruptVaultError, VaultLockedError } from '../vault/errors'
import * as keyring from '../vault/keyring'
import { encryptRecord } from '../vault/records'
import { vaultInternals } from '../vault/store'
import {
  getMcpServer,
  listMcpServers,
  removeMcpServer,
  saveMcpOAuth,
  saveMcpServer,
} from './store'
import { McpParseError } from './types'
import type { McpServerConfig } from './types'

const KDF = { algorithm: 'PBKDF2-SHA256' as const, iterations: 1000, salt: randomBytes(16) }
const MARKER_SECRET = 'MARKER_SECRET_5b1e77'
const MARKER_TOKEN = 'MARKER_TOKEN_90c2aa'

async function installKey(password = 'mcp-password'): Promise<void> {
  keyring.reset()
  keyring.install(await deriveKey(password, KDF))
}

function server(patch: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'mcp_aaaaaaaaaaaaaaaa',
    name: 'Linear',
    url: 'https://mcp.example.com/mcp',
    transport: 'auto',
    auth: { kind: 'headers', headers: { Authorization: `Bearer ${MARKER_SECRET}` } },
    enabled: true,
    disabledTools: [],
    timeoutMs: 60_000,
    ...patch,
  }
}

function asText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

describe('encrypted MCP server store', () => {
  beforeEach(async () => {
    await db.mcpServers.clear()
    await installKey()
  })

  it('keeps header secrets and tokens out of the raw row, because the row sits in IndexedDB unencrypted-at-rest', async () => {
    await saveMcpServer(server())
    await saveMcpOAuth('mcp_aaaaaaaaaaaaaaaa', () => ({ tokens: { access_token: MARKER_TOKEN } }))
    const row = await db.mcpServers.get('mcp_aaaaaaaaaaaaaaaa')
    expect(Object.keys(row ?? {}).sort()).toEqual(['blob', 'id', 'updatedAt'])
    const raw = `${JSON.stringify(row)}${asText(row!.blob.ciphertext)}${asText(row!.blob.iv)}`
    expect(raw).not.toContain(MARKER_SECRET)
    expect(raw).not.toContain(MARKER_TOKEN)
    expect(raw).not.toContain('mcp.example.com')
  })

  it('round-trips save, list, get, and remove', async () => {
    const first = server()
    const second = server({ id: 'mcp_bbbbbbbbbbbbbbbb', name: 'Notion', auth: { kind: 'none' } })
    await saveMcpServer(first)
    await saveMcpServer(second)
    const listed = await listMcpServers()
    expect(listed.map((entry) => entry.config).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      first,
      second,
    ])
    expect((await getMcpServer(second.id))?.oauth).toEqual({})

    await removeMcpServer(first.id)
    expect((await listMcpServers()).map((entry) => entry.config.id)).toEqual([second.id])
  })

  it('keeps OAuth state when the user edits the config, so an edit does not sign the user out', async () => {
    await saveMcpServer(server({ auth: { kind: 'oauth' } }))
    await saveMcpOAuth('mcp_aaaaaaaaaaaaaaaa', () => ({ tokens: { access_token: 't' } }))
    await saveMcpServer(server({ name: 'Renamed', auth: { kind: 'oauth' } }))
    const entry = await getMcpServer('mcp_aaaaaaaaaaaaaaaa')
    expect(entry?.config.name).toBe('Renamed')
    expect(entry?.oauth.tokens).toEqual({ access_token: 't' })
  })

  it('serializes concurrent config and OAuth writes so neither is lost', async () => {
    await saveMcpServer(server({ auth: { kind: 'oauth' } }))
    await Promise.all([
      saveMcpServer(server({ name: 'Concurrent', auth: { kind: 'oauth' } })),
      saveMcpOAuth('mcp_aaaaaaaaaaaaaaaa', (current) => ({ ...current, codeVerifier: 'v' })),
    ])
    const entry = await getMcpServer('mcp_aaaaaaaaaaaaaaaa')
    expect(entry?.config.name).toBe('Concurrent')
    expect(entry?.oauth.codeVerifier).toBe('v')
  })

  it('refuses OAuth writes for a server that was removed', async () => {
    await expect(saveMcpOAuth('mcp_missing', () => ({}))).rejects.toBeInstanceOf(McpParseError)
  })

  it('refuses an invalid config before writing anything', async () => {
    await expect(saveMcpServer(server({ url: 'http://evil.example.com' }))).rejects.toThrow()
    expect(await listMcpServers()).toEqual([])
  })

  it('refuses to read a record under a different key', async () => {
    await saveMcpServer(server())
    await installKey('another-password')
    await expect(listMcpServers()).rejects.toBeInstanceOf(CorruptVaultError)
  })

  it('refuses to read or write while the vault is locked', async () => {
    await saveMcpServer(server())
    keyring.clear()
    await expect(listMcpServers()).rejects.toBeInstanceOf(VaultLockedError)
    await expect(saveMcpServer(server({ id: 'mcp_cccccccccccccccc' }))).rejects.toBeInstanceOf(
      VaultLockedError,
    )
  })

  it('rejects a record copied under another id, because the AAD binds a blob to its row', async () => {
    const envelope = JSON.stringify({ version: 1, config: server(), oauth: {} })
    await db.mcpServers.put({
      id: 'mcp_zzzzzzzzzzzzzzzz',
      blob: await encryptRecord(envelope, 'mcp:mcp_aaaaaaaaaaaaaaaa'),
      updatedAt: 1,
    })
    await expect(listMcpServers()).rejects.toBeInstanceOf(CorruptVaultError)
  })

  it('rejects an envelope whose config id does not match its row', async () => {
    const envelope = JSON.stringify({ version: 1, config: server(), oauth: {} })
    await db.mcpServers.put({
      id: 'mcp_zzzzzzzzzzzzzzzz',
      blob: await encryptRecord(envelope, 'mcp:mcp_zzzzzzzzzzzzzzzz'),
      updatedAt: 1,
    })
    await expect(listMcpServers()).rejects.toBeInstanceOf(McpParseError)
  })

  it('rejects an envelope newer than this build understands', async () => {
    const envelope = JSON.stringify({ version: 2, config: server(), oauth: {} })
    await db.mcpServers.put({
      id: 'mcp_aaaaaaaaaaaaaaaa',
      blob: await encryptRecord(envelope, 'mcp:mcp_aaaaaaaaaaaaaaaa'),
      updatedAt: 1,
    })
    await expect(listMcpServers()).rejects.toBeInstanceOf(McpParseError)
  })
})

describe('vault recovery', () => {
  it('wipes every MCP server, because the old key can never decrypt them again', async () => {
    await db.mcpServers.clear()
    await installKey()
    await saveMcpServer(server())
    expect(await db.mcpServers.count()).toBe(1)
    await vaultInternals.reset()
    expect(await db.mcpServers.count()).toBe(0)
  })
})

describe('schema upgrade', () => {
  it('opens a v7 database with its data intact and an empty MCP table', async () => {
    const name = `sagent-upgrade-${crypto.randomUUID()}`
    const legacy = new Dexie(name)
    legacy.version(7).stores({
      vault: 'id',
      meta: 'id',
      threads: 'id, updatedAt',
      skills: 'id, updatedAt',
      tools: 'id, updatedAt',
      fs: 'id',
      journals: 'id, updatedAt',
      documents: 'id, updatedAt',
      chunks: 'id, docId, [docId+ordinal]',
      memories: 'id, updatedAt',
    })
    await legacy.open()
    await legacy.table('memories').put({ id: 'mem_1', blob: { iv: 1 }, updatedAt: 1 })
    legacy.close()

    const upgraded = new VaultDatabase(name)
    await upgraded.open()
    expect(upgraded.verno).toBe(8)
    expect(await upgraded.memories.get('mem_1')).toEqual({ id: 'mem_1', blob: { iv: 1 }, updatedAt: 1 })
    expect(await upgraded.mcpServers.count()).toBe(0)
    upgraded.close()
    await Dexie.delete(name)
  })
})
