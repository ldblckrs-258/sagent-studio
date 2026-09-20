import { describe, expect, it, vi } from 'vitest'
import type { SkillRef } from '../chat/types'
import { SkillRegistry } from '../skills/registry'
import type { SkillStore } from '../skills/registry'
import type { SkillManifest } from '../skills/schema'
import { VaultLockedError } from '../vault/errors'
import { createAdminPorts, createSkillAdminPort, createToolAdminPort } from './admin-ports'
import { ToolRegistry } from './registry'
import type { ToolStore } from './registry'
import { ToolNameConflictError } from './types'
import type { ToolDefinition } from './types'

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

function memorySkillStore(): SkillStore & { rows: Map<string, SkillManifest> } {
  const rows = new Map<string, SkillManifest>()
  return {
    rows,
    save: async (entry) => {
      rows.set(entry.id, entry)
    },
    remove: async (id) => {
      rows.delete(id)
    },
    list: async () => [...rows.values()],
  }
}

function httpTool(name: string, enabled = true): ToolDefinition {
  return {
    kind: 'http',
    name,
    description: `http ${name}`,
    inputSchema: { type: 'object' },
    request: {
      method: 'GET',
      url: 'https://api.example.com/x',
      allowedOrigins: ['https://api.example.com'],
    },
    enabled,
  }
}

function memoryToolStore(): ToolStore & { rows: Map<string, ToolDefinition> } {
  const rows = new Map<string, ToolDefinition>()
  return {
    rows,
    save: async (definition) => {
      rows.set(definition.name, definition)
    },
    remove: async (name) => {
      rows.delete(name)
    },
    list: async () => [...rows.values()],
  }
}

function fakeEnablement(initial: SkillRef[] | null = null) {
  const state = { policy: initial, saves: 0, failFrom: undefined as number | undefined }
  return {
    state,
    port: {
      load: async () => state.policy,
      save: async (refs: readonly SkillRef[]) => {
        state.saves += 1
        if (state.failFrom !== undefined && state.saves >= state.failFrom) {
          throw new VaultLockedError()
        }
        state.policy = [...refs]
      },
    },
  }
}

function draft(overrides: Partial<SkillManifest> = {}) {
  const { id, name, description, instructions, allowedTools } = manifest(overrides)
  return { id, name, description, instructions, allowedTools }
}

describe('SkillAdminPort', () => {
  it('creates and lists a vault skill disabled by default', async () => {
    const registry = new SkillRegistry(memorySkillStore())
    const port = createSkillAdminPort(registry)

    const entry = await port.create(draft({ id: 'new', name: 'New' }))

    expect(entry).toMatchObject({ id: 'new', source: 'vault', enabled: false })
    expect(port.list().map((item) => item.id)).toEqual(['new'])
  })

  it('records the enablement ref when created enabled', async () => {
    const enablement = fakeEnablement([])
    const registry = new SkillRegistry(memorySkillStore(), enablement.port)
    const port = createSkillAdminPort(registry)

    const entry = await port.create(draft({ id: 'on' }), { enabled: true })

    expect(entry.enabled).toBe(true)
    expect(enablement.state.policy).toEqual([{ id: 'on', source: 'vault' }])
  })

  it('rejects an id that already exists under any source', async () => {
    const registry = new SkillRegistry(memorySkillStore())
    registry.register(manifest({ id: 'ws', source: 'workspace' }))
    const port = createSkillAdminPort(registry)

    await expect(port.create(draft({ id: 'ws' }))).rejects.toBeInstanceOf(ToolNameConflictError)
  })

  it('merges an update patch and preserves unsupplied fields', async () => {
    const store = memorySkillStore()
    const registry = new SkillRegistry(store)
    const port = createSkillAdminPort(registry)
    await port.create(draft({ id: 'edit', name: 'Before', instructions: 'keep me' }))

    const updated = await port.update({ id: 'edit', source: 'vault' }, { name: 'After' })

    expect(updated).toMatchObject({ name: 'After', instructions: 'keep me' })
    expect(store.rows.get('edit')?.instructions).toBe('keep me')
  })

  it('removes a skill and its enablement', async () => {
    const store = memorySkillStore()
    const enablement = fakeEnablement([])
    const registry = new SkillRegistry(store, enablement.port)
    const port = createSkillAdminPort(registry)
    await port.create(draft({ id: 'gone' }), { enabled: true })

    await port.remove({ id: 'gone', source: 'vault' })

    expect(store.rows.has('gone')).toBe(false)
    expect(enablement.state.policy).toEqual([])
  })

  it('reconciles a swallowed enablement write to disabled', async () => {
    const store = memorySkillStore()
    const enablement = fakeEnablement([])
    const registry = new SkillRegistry(store, enablement.port)
    const port = createSkillAdminPort(registry)
    enablement.state.failFrom = 2

    const entry = await port.create(draft({ id: 'unlucky' }), { enabled: true })

    expect(entry.enabled).toBe(false)
    expect(registry.isEnabled({ id: 'unlucky', source: 'vault' })).toBe(false)
  })

  it('serializes concurrent same-name creates through createAdminPorts', async () => {
    const skillRegistry = new SkillRegistry(memorySkillStore())
    const ports = createAdminPorts({ skillRegistry, toolRegistry: new ToolRegistry(memoryToolStore()) })

    const results = await Promise.allSettled([
      ports.skillAdmin.create(draft({ id: 'race' })),
      ports.skillAdmin.create(draft({ id: 'race' })),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(ToolNameConflictError)
  })
})

describe('ToolAdminPort', () => {
  it('saves then registers a user tool', async () => {
    const store = memoryToolStore()
    const registry = new ToolRegistry(store)
    const port = createToolAdminPort(registry, store)

    const entry = await port.create(httpTool('fetch_thing', false))

    expect(entry).toEqual({
      name: 'fetch_thing',
      kind: 'http',
      description: 'http fetch_thing',
      enabled: false,
      summary: 'GET https://api.example.com/x',
    })
    expect(store.rows.has('fetch_thing')).toBe(true)
    expect(registry.list().map((item) => item.name)).toEqual(['fetch_thing'])
  })

  it('rejects a provider or user name before writing anything', async () => {
    const store = memoryToolStore()
    const registry = new ToolRegistry(store)
    const save = vi.spyOn(store, 'save')
    registry.registerUserTool(httpTool('existing'))
    const port = createToolAdminPort(registry, store)

    await expect(port.create(httpTool('existing'))).rejects.toBeInstanceOf(ToolNameConflictError)
    expect(save).not.toHaveBeenCalled()
  })

  it('rolls the store row back when registration rejects after a save', async () => {
    const store = memoryToolStore()
    const registry = new ToolRegistry(store)
    const port = createToolAdminPort(registry, store)
    registry.registerUserTool = () => {
      throw new Error('boom')
    }

    await expect(port.create(httpTool('orphan'))).rejects.toThrow('boom')
    expect(store.rows.has('orphan')).toBe(false)
  })

  it('overwrites a tool in place for a same-name update', async () => {
    const store = memoryToolStore()
    const registry = new ToolRegistry(store)
    const port = createToolAdminPort(registry, store)
    await port.create(httpTool('same', false))

    const updated = await port.update('same', { ...httpTool('same', true), description: 'changed' })

    expect(updated.enabled).toBe(true)
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0].description).toBe('changed')
  })

  it('renames a tool and leaves only the new name registered', async () => {
    const store = memoryToolStore()
    const registry = new ToolRegistry(store)
    const port = createToolAdminPort(registry, store)
    await port.create(httpTool('old'))

    await port.update('old', httpTool('new'))

    expect(store.rows.has('old')).toBe(false)
    expect(store.rows.has('new')).toBe(true)
    expect(registry.list().map((item) => item.name)).toEqual(['new'])
  })

  it('rolls back both rows when a rename fails after the first write', async () => {
    const store = memoryToolStore()
    const registry = new ToolRegistry(store)
    const port = createToolAdminPort(registry, store)
    await port.create(httpTool('old'))
    const originalRegister = registry.registerUserTool.bind(registry)
    registry.registerUserTool = (definition) => {
      if (definition.name === 'new') throw new Error('boom')
      originalRegister(definition)
    }

    await expect(port.update('old', httpTool('new'))).rejects.toThrow('boom')

    expect(store.rows.has('new')).toBe(false)
    expect(store.rows.has('old')).toBe(true)
    expect(registry.list().map((item) => item.name)).toEqual(['old'])
  })

  it('deletes a tool and its store row', async () => {
    const store = memoryToolStore()
    const registry = new ToolRegistry(store)
    const port = createToolAdminPort(registry, store)
    await port.create(httpTool('deleteme'))

    await port.remove('deleteme')

    expect(store.rows.has('deleteme')).toBe(false)
    expect(registry.list()).toEqual([])
  })
})
