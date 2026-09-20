import { beforeEach, describe, expect, it } from 'vitest'
import type { SkillRef } from '../../chat/types'
import type { SkillEnablementPort } from '../../skills/enablement'
import { SkillRegistry } from '../../skills/registry'
import { skillStore } from '../../skills/store'
import { deriveKey, randomBytes } from '../../vault/crypto'
import { db } from '../../vault/db'
import { VaultLockedError } from '../../vault/errors'
import * as keyring from '../../vault/keyring'
import { vaultInternals } from '../../vault/store'
import { createSkillAdminPort, createToolAdminPort } from '../admin-ports'
import { ToolRegistry } from '../registry'
import type { HttpToolDefinition, SandboxJsToolDefinition } from '../types'
import { toolStore } from '../store'

const KDF = { algorithm: 'PBKDF2-SHA256' as const, iterations: 1000, salt: randomBytes(16) }

function sandboxTool(name: string, description: string): SandboxJsToolDefinition {
  return {
    kind: 'sandbox-js',
    name,
    description,
    inputSchema: { type: 'object' },
    source: 'return input',
    enabled: false,
  }
}

function httpTool(name: string, description = `http ${name}`): HttpToolDefinition {
  return {
    kind: 'http',
    name,
    description,
    inputSchema: { type: 'object' },
    request: {
      method: 'GET',
      url: 'https://api.example.com/x',
      allowedOrigins: ['https://api.example.com'],
    },
    enabled: false,
  }
}

function fakeEnablement(initial: SkillRef[] = []) {
  const state = {
    policy: initial as SkillRef[] | null,
    saves: 0,
    failFrom: undefined as number | undefined,
  }
  const port: SkillEnablementPort = {
    load: async () => state.policy,
    save: async (refs) => {
      state.saves += 1
      if (state.failFrom !== undefined && state.saves >= state.failFrom) {
        throw new VaultLockedError()
      }
      state.policy = [...refs]
    },
  }
  return { state, port }
}

async function rawStoreBytes(which: 'skills' | 'tools'): Promise<string> {
  const rows = which === 'skills' ? await db.skills.toArray() : await db.tools.toArray()
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
  for (const row of rows) collect(row)
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged)
}

describe('admin port persistence', () => {
  beforeEach(async () => {
    await vaultInternals.reset()
    keyring.install(await deriveKey('admin-password', KDF))
  })

  it('round-trips a created skill encrypted, disabled, and without plaintext', async () => {
    const marker = 'ADMIN_SKILL_MARKER_1a2b'
    const enablement = fakeEnablement([])
    const registry = new SkillRegistry(skillStore, enablement.port)
    const admin = createSkillAdminPort(registry)

    const entry = await admin.create({
      id: 'made',
      name: 'Made',
      description: 'A made skill',
      instructions: marker,
      allowedTools: [],
    })
    expect(entry.enabled).toBe(false)
    expect(await rawStoreBytes('skills')).not.toContain(marker)

    const fresh = new SkillRegistry(skillStore, enablement.port)
    await fresh.hydrate()
    expect(fresh.get({ id: 'made', source: 'vault' })?.instructions).toBe(marker)
    expect(fresh.isEnabled({ id: 'made', source: 'vault' })).toBe(false)
  })

  it('round-trips sandbox-js and http tools encrypted and disabled', async () => {
    const marker = 'ADMIN_TOOL_MARKER_9f8e'
    const admin = createToolAdminPort(new ToolRegistry(toolStore), toolStore)

    await admin.create(sandboxTool('sandbox_made', marker))
    await admin.create(httpTool('fetch_made'))
    expect(await rawStoreBytes('tools')).not.toContain(marker)

    const fresh = new ToolRegistry(toolStore)
    await fresh.hydrate()
    expect(fresh.list().map((entry) => entry.name)).toEqual(['fetch_made', 'sandbox_made'])
    expect(fresh.list().every((entry) => entry.enabled === false)).toBe(true)
  })

  it('renames a tool and leaves only the new name after re-hydration', async () => {
    const admin = createToolAdminPort(new ToolRegistry(toolStore), toolStore)
    await admin.create(httpTool('old_name'))

    await admin.update('old_name', httpTool('new_name'))

    const fresh = new ToolRegistry(toolStore)
    await fresh.hydrate()
    expect(fresh.list().map((entry) => entry.name)).toEqual(['new_name'])
  })

  it('reconcilies a failed enablement write to disabled across a reload', async () => {
    const enablement = fakeEnablement([])
    const registry = new SkillRegistry(skillStore, enablement.port)
    const admin = createSkillAdminPort(registry)
    enablement.state.failFrom = 2

    const entry = await admin.create(
      { id: 'unlucky', name: 'Unlucky', description: '', instructions: 'body', allowedTools: [] },
      { enabled: true },
    )
    expect(entry.enabled).toBe(false)

    const fresh = new SkillRegistry(skillStore, enablement.port)
    await fresh.hydrate()
    expect(fresh.isEnabled({ id: 'unlucky', source: 'vault' })).toBe(false)
  })
})
