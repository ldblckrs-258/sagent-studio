import { beforeEach, describe, expect, it } from 'vitest'
import { deriveKey, randomBytes } from '../vault/crypto'
import { db } from '../vault/db'
import * as keyring from '../vault/keyring'
import { vaultInternals } from '../vault/store'
import { SkillRegistry } from './registry'
import type { SkillStore } from './registry'
import { skillKey } from './schema'
import type { SkillManifest } from './schema'

const KDF = { algorithm: 'PBKDF2-SHA256' as const, iterations: 1000, salt: randomBytes(16) }

function manifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    id: 's1',
    name: 'Skill One',
    description: 'A skill',
    instructions: 'Do the thing.',
    allowedTools: [],
    source: 'vault',
    ...overrides,
  }
}

function fakeStore(): SkillStore & { saved: SkillManifest[]; removed: string[] } {
  const saved: SkillManifest[] = []
  const removed: string[] = []
  return {
    saved,
    removed,
    save: async (entry) => {
      saved.push(entry)
    },
    remove: async (id) => {
      removed.push(id)
    },
    list: async () => saved.slice(),
  }
}

describe('SkillRegistry', () => {
  it('resolves refs and preserves each source', () => {
    const registry = new SkillRegistry(fakeStore())
    registry.register(manifest({ id: 'v1', source: 'vault' }), { enabled: true })
    registry.register(manifest({ id: 'w1', source: 'workspace' }), { enabled: true })

    const resolved = registry.resolve([
      { id: 'w1', source: 'workspace' },
      { id: 'v1', source: 'vault' },
    ])
    expect(resolved.map((entry) => [entry.id, entry.source])).toEqual([
      ['v1', 'vault'],
      ['w1', 'workspace'],
    ])
  })

  it('gates participation on setEnabled', () => {
    const registry = new SkillRegistry(fakeStore())
    registry.register(manifest({ id: 'off' }), { enabled: false })
    expect(registry.resolve([{ id: 'off', source: 'vault' }])).toEqual([])

    registry.setEnabled({ id: 'off', source: 'vault' }, true)
    expect(registry.resolve([{ id: 'off', source: 'vault' }])).toHaveLength(1)
  })

  it('ignores refs that are not registered', () => {
    const registry = new SkillRegistry(fakeStore())
    expect(registry.resolve([{ id: 'ghost', source: 'vault' }])).toEqual([])
  })

  it('lets a skill narrow the tool pool but never widen it', () => {
    const registry = new SkillRegistry(fakeStore())
    const pool = new Set(['read_file'])
    registry.register(manifest({ id: 'wide', allowedTools: ['read_file', 'write_file'] }), {
      enabled: true,
    })
    expect(registry.toolNamesFor([{ id: 'wide', source: 'vault' }], pool)).toEqual(['read_file'])

    registry.register(manifest({ id: 'miss', allowedTools: ['write_file'] }), { enabled: true })
    expect(registry.toolNamesFor([{ id: 'miss', source: 'vault' }], pool)).toEqual([])
  })

  it('treats an empty allowedTools list as the whole pool', () => {
    const registry = new SkillRegistry(fakeStore())
    registry.register(manifest({ id: 'all', allowedTools: [] }), { enabled: true })
    const pool = new Set(['read_file', 'write_file'])
    expect(registry.toolNamesFor([{ id: 'all', source: 'vault' }], pool)).toEqual([
      'read_file',
      'write_file',
    ])
  })

  it('returns undefined when no skill narrows the pool', () => {
    const registry = new SkillRegistry(fakeStore())
    expect(registry.toolNamesFor([], new Set(['read_file']))).toBeUndefined()
  })

  it('registers workspace skills as untrusted and disabled', async () => {
    const registry = new SkillRegistry(fakeStore())
    await registry.loadWorkspaceSkills({
      list: async () => [manifest({ id: 'ws', source: 'vault', instructions: 'Repo content.' })],
    })

    expect(registry.get({ id: 'ws', source: 'workspace' })).toBeDefined()
    expect(registry.isEnabled({ id: 'ws', source: 'workspace' })).toBe(false)
    expect(registry.resolve([{ id: 'ws', source: 'workspace' }])).toEqual([])
  })

  describe('encrypted persistence', () => {
    beforeEach(async () => {
      await vaultInternals.reset()
      keyring.install(await deriveKey('skill-password', KDF))
    })

    async function rawSkills(): Promise<string> {
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
      for (const record of await db.skills.toArray()) collect(record)
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
      const merged = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.byteLength
      }
      return new TextDecoder('utf-8', { fatal: false }).decode(merged)
    }

    it('imports encrypted and survives reload without plaintext leakage', async () => {
      const registry = new SkillRegistry()
      const marker = 'SKILL_INSTRUCTIONS_MARKER_4b7e'
      await registry.importSkill(manifest({ id: 'imp', instructions: marker }))

      expect(await rawSkills()).not.toContain(marker)

      const reloaded = new SkillRegistry()
      await reloaded.hydrate()
      expect(reloaded.get({ id: 'imp', source: 'vault' })?.instructions).toBe(marker)
      expect(reloaded.isEnabled({ id: 'imp', source: 'vault' })).toBe(true)
    })

    it('updates and removes a persisted skill', async () => {
      const registry = new SkillRegistry()
      await registry.importSkill(manifest({ id: 'edit', instructions: 'before' }))
      await registry.updateSkill(manifest({ id: 'edit', instructions: 'after' }))
      expect(registry.get({ id: 'edit', source: 'vault' })?.instructions).toBe('after')

      const reloaded = new SkillRegistry()
      await reloaded.hydrate()
      expect(reloaded.get({ id: 'edit', source: 'vault' })?.instructions).toBe('after')

      await registry.removeSkill({ id: 'edit', source: 'vault' })
      expect(registry.get({ id: 'edit', source: 'vault' })).toBeUndefined()
      const afterRemove = new SkillRegistry()
      await afterRemove.hydrate()
      expect(afterRemove.get({ id: 'edit', source: 'vault' })).toBeUndefined()
    })

    it('rejects updating an unregistered skill', async () => {
      const registry = new SkillRegistry()
      await expect(registry.updateSkill(manifest({ id: 'nope' }))).rejects.toThrow()
    })
  })
})

describe('skillKey', () => {
  it('distinguishes sources with the same id', () => {
    expect(skillKey({ id: 'x', source: 'vault' })).not.toBe(skillKey({ id: 'x', source: 'workspace' }))
  })
})
