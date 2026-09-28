import { db } from '../vault/db'
import { decryptRecord, encryptRecord } from '../vault/records'
import { vaultWriteQueue } from '../vault/write-queue'
import { McpParseError, validateMcpServerConfig } from './types'
import type { McpOAuthState, McpServerConfig, McpServerEntry } from './types'

export const MCP_ENVELOPE_VERSION = 1

function aadSeed(id: string): string {
  return `mcp:${id}`
}

function parseOAuth(value: unknown): McpOAuthState {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new McpParseError('The stored OAuth state is malformed.')
  }
  const raw = value as Record<string, unknown>
  if (raw.codeVerifier !== undefined && typeof raw.codeVerifier !== 'string') {
    throw new McpParseError('The stored OAuth code verifier is malformed.')
  }
  return {
    ...(raw.clientInformation !== undefined ? { clientInformation: raw.clientInformation } : {}),
    ...(raw.tokens !== undefined ? { tokens: raw.tokens } : {}),
    ...(typeof raw.codeVerifier === 'string' ? { codeVerifier: raw.codeVerifier } : {}),
    ...(raw.discoveryState !== undefined ? { discoveryState: raw.discoveryState } : {}),
  }
}

function parseEnvelope(raw: string, id: string): McpServerEntry {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new McpParseError('The decrypted MCP server was not valid JSON.', { cause })
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new McpParseError('The MCP server envelope was not an object.')
  }
  const version = (parsed as { version?: unknown }).version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new McpParseError('The MCP server envelope version is invalid.')
  }
  if (version > MCP_ENVELOPE_VERSION) {
    throw new McpParseError(`MCP server envelope version ${version} is newer than this app supports.`)
  }
  let config: McpServerConfig
  try {
    config = validateMcpServerConfig((parsed as { config?: unknown }).config)
  } catch (cause) {
    throw new McpParseError('The stored MCP server configuration is malformed.', { cause })
  }
  if (config.id !== id) throw new McpParseError('The stored MCP server id does not match its record.')
  return { config, oauth: parseOAuth((parsed as { oauth?: unknown }).oauth) }
}

async function readEntry(id: string): Promise<McpServerEntry | undefined> {
  const row = await db.mcpServers.get(id)
  if (!row) return undefined
  return parseEnvelope(await decryptRecord(row.blob, aadSeed(row.id)), row.id)
}

async function writeEntry(entry: McpServerEntry): Promise<void> {
  const envelope = JSON.stringify({ version: MCP_ENVELOPE_VERSION, ...entry })
  const blob = await encryptRecord(envelope, aadSeed(entry.config.id))
  await db.mcpServers.put({ id: entry.config.id, blob, updatedAt: Date.now() })
}

export async function listMcpServers(): Promise<McpServerEntry[]> {
  const rows = await db.mcpServers.toArray()
  return Promise.all(
    rows.map(async (row) => parseEnvelope(await decryptRecord(row.blob, aadSeed(row.id)), row.id)),
  )
}

export async function getMcpServer(id: string): Promise<McpServerEntry | undefined> {
  return readEntry(id)
}

export async function saveMcpServer(config: McpServerConfig): Promise<void> {
  const valid = validateMcpServerConfig(config)
  await vaultWriteQueue.enqueue(async () => {
    const existing = await readEntry(valid.id)
    await writeEntry({ config: valid, oauth: existing?.oauth ?? {} })
  })
}

export async function saveMcpOAuth(
  id: string,
  update: (current: McpOAuthState) => McpOAuthState,
): Promise<void> {
  await vaultWriteQueue.enqueue(async () => {
    const existing = await readEntry(id)
    if (!existing) throw new McpParseError(`No MCP server is stored under "${id}".`)
    await writeEntry({ config: existing.config, oauth: parseOAuth(update(existing.oauth)) })
  })
}

export async function removeMcpServer(id: string): Promise<void> {
  await vaultWriteQueue.enqueue(async () => {
    await db.mcpServers.delete(id)
  })
}

export interface McpServerPersistence {
  list(): Promise<McpServerEntry[]>
  get(id: string): Promise<McpServerEntry | undefined>
  save(config: McpServerConfig): Promise<void>
  saveOAuth(id: string, update: (current: McpOAuthState) => McpOAuthState): Promise<void>
  remove(id: string): Promise<void>
}

export const mcpServerStore: McpServerPersistence = {
  list: listMcpServers,
  get: getMcpServer,
  save: saveMcpServer,
  saveOAuth: saveMcpOAuth,
  remove: removeMcpServer,
}
