import { beforeEach, describe, expect, it } from 'vitest'
import { deriveKey, randomBytes } from '../vault/crypto'
import { db } from '../vault/db'
import * as keyring from '../vault/keyring'
import { vaultInternals } from '../vault/store'
import { deleteTool, listTools, loadTool, saveTool } from './store'
import { ToolSchemaError } from './types'
import type { ToolDefinition } from './types'

const KDF = { algorithm: 'PBKDF2-SHA256' as const, iterations: 1000, salt: randomBytes(16) }

function httpTool(name: string, description = `http ${name}`): ToolDefinition {
  return {
    kind: 'http',
    name,
    description,
    inputSchema: { type: 'object' },
    request: { method: 'GET', url: 'https://api.example.com/x', allowedOrigins: ['https://api.example.com'] },
    enabled: true,
  }
}

async function rawTools(): Promise<string> {
  const chunks: Uint8Array[] = []
  const collect = (value: unknown): void => {
    if (value instanceof Uint8Array) {
      chunks.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item)
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const nested of Object.values(value as Record<string, unknown>)) collect(nested)
    }
  }
  for (const record of await db.tools.toArray()) collect(record)
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged)
}

describe('tool persistence', () => {
  beforeEach(async () => {
    await vaultInternals.reset()
    keyring.install(await deriveKey('tool-password', KDF))
  })

  it('round-trips a tool encrypted with no plaintext description', async () => {
    const marker = 'TOOL_DESCRIPTION_MARKER_71c0'
    const definition = httpTool('fetch_thing', marker)
    await saveTool(definition)

    expect(await rawTools()).not.toContain(marker)
    await expect(loadTool('fetch_thing')).resolves.toEqual(definition)
    await expect(loadTool('missing')).resolves.toBeNull()
  })

  it('lists tools deterministically and deletes them', async () => {
    await saveTool(httpTool('zeta'))
    await saveTool(httpTool('alpha'))
    await expect(listTools()).resolves.toMatchObject([{ name: 'alpha' }, { name: 'zeta' }])

    await deleteTool('alpha')
    await expect(loadTool('alpha')).resolves.toBeNull()
  })

  it('rejects a malformed definition on save', async () => {
    await expect(
      saveTool({ ...httpTool('bad'), kind: 'nope' } as unknown as ToolDefinition),
    ).rejects.toBeInstanceOf(ToolSchemaError)
  })

  it('rejects an http tool with a non-string header value', async () => {
    const malformed = {
      kind: 'http',
      name: 'bad_header',
      description: 'x',
      inputSchema: { type: 'object' },
      request: {
        method: 'GET',
        url: 'https://api.example.com/x',
        allowedOrigins: ['https://api.example.com'],
        headers: { 'x-token': 1 },
      },
      enabled: true,
    } as unknown as ToolDefinition
    await expect(saveTool(malformed)).rejects.toBeInstanceOf(ToolSchemaError)
  })
})
