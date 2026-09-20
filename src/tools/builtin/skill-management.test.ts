import { describe, expect, it } from 'vitest'
import type { SkillAdminEntry, SkillAdminPort, SkillDraft, ToolRuntimePorts } from '../types'
import { ToolNotFoundError } from '../types'
import { createSkillManagementProvider } from './skill-management'

const CALL_OPTIONS = { toolCallId: 'call-1', messages: [], context: {} }

function key(id: string, source: 'vault' | 'workspace'): string {
  return `${source}:${id}`
}

function entry(overrides: Partial<SkillAdminEntry> = {}): SkillAdminEntry {
  return {
    id: 's1',
    name: 'Skill One',
    description: 'A skill',
    instructions: 'Do it.',
    allowedTools: [],
    source: 'vault',
    enabled: false,
    ...overrides,
  }
}

function fakeSkillAdmin() {
  const entries = new Map<string, SkillAdminEntry>()
  const seed = (value: SkillAdminEntry): void => {
    entries.set(key(value.id, value.source), value)
  }
  const port: SkillAdminPort = {
    list: () => [...entries.values()],
    get: (id, source) => entries.get(key(id, source)),
    exists: (id) => [...entries.values()].some((item) => item.id === id),
    async create(draft: SkillDraft, options?: { enabled?: boolean }) {
      const next = entry({ ...draft, source: 'vault', enabled: options?.enabled ?? false })
      entries.set(key(draft.id, 'vault'), next)
      return next
    },
    async update(ref, patch, options) {
      const current = entries.get(key(ref.id, ref.source))
      if (!current) throw new ToolNotFoundError(ref.id)
      const next = { ...current, ...patch, enabled: options?.enabled ?? current.enabled }
      entries.set(key(ref.id, ref.source), next)
      return next
    },
    async remove(ref) {
      entries.delete(key(ref.id, ref.source))
    },
  }
  return { port, seed, entries }
}

function ports(skillAdmin?: SkillAdminPort): ToolRuntimePorts {
  return skillAdmin ? { skillAdmin } : {}
}

async function run(name: string, skillAdmin: SkillAdminPort, input: unknown) {
  const provider = createSkillManagementProvider()
  const built = provider.create(name, ports(skillAdmin))
  if (!built.execute) throw new Error('missing execute')
  return built.execute(input, CALL_OPTIONS)
}

describe('skill management provider', () => {
  it('is unavailable without a skill admin port', () => {
    const provider = createSkillManagementProvider()
    expect(provider.isAvailable(ports())).toBe(false)
    expect(provider.isAvailable(ports(fakeSkillAdmin().port))).toBe(true)
  })

  it('lists skills and honors the source filter', async () => {
    const admin = fakeSkillAdmin()
    admin.seed(entry({ id: 'v1', name: 'V', source: 'vault' }))
    admin.seed(entry({ id: 'w1', name: 'W', source: 'workspace' }))

    const all = await run('list_skills', admin.port, {})
    expect(all).toMatchObject({ ok: true, code: 'ok' })
    expect((all as { value: { count: number } }).value.count).toBe(2)

    const workspace = await run('list_skills', admin.port, { source: 'workspace' })
    expect((workspace as { value: { skills: Array<{ id: string }> } }).value.skills).toEqual([
      expect.objectContaining({ id: 'w1' }),
    ])
  })

  it('creates a skill disabled by default', async () => {
    const admin = fakeSkillAdmin()
    const result = await run('create_skill', admin.port, {
      id: 'new',
      name: 'New',
      instructions: 'Body',
    })
    expect(result).toMatchObject({ ok: true, code: 'ok' })
    expect((result as { value: { enabled: boolean } }).value.enabled).toBe(false)
  })

  it('returns conflict for a vault or workspace duplicate id', async () => {
    const admin = fakeSkillAdmin()
    admin.seed(entry({ id: 'dup' }))
    expect(await run('create_skill', admin.port, { id: 'dup', name: 'X', instructions: 'i' })).toMatchObject(
      { ok: false, code: 'conflict' },
    )

    const workspace = fakeSkillAdmin()
    workspace.seed(entry({ id: 'ws', source: 'workspace' }))
    expect(
      await run('create_skill', workspace.port, { id: 'ws', name: 'X', instructions: 'i' }),
    ).toMatchObject({ ok: false, code: 'conflict' })
  })

  it('rejects an empty id or missing instructions', async () => {
    const admin = fakeSkillAdmin()
    expect(
      await run('create_skill', admin.port, { id: '', name: 'X', instructions: 'i' }),
    ).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(await run('create_skill', admin.port, { id: 'ok', name: 'X' })).toMatchObject({
      ok: false,
      code: 'invalid_input',
    })
  })

  it('updates a vault skill and rejects missing, workspace, and empty patches', async () => {
    const admin = fakeSkillAdmin()
    admin.seed(entry({ id: 'v1', name: 'Before', instructions: 'keep' }))

    expect(await run('update_skill', admin.port, { id: 'v1', name: 'After' })).toMatchObject({
      ok: true,
      code: 'ok',
    })
    expect(admin.entries.get('vault:v1')?.instructions).toBe('keep')

    expect(await run('update_skill', admin.port, { id: 'ghost', name: 'X' })).toMatchObject({
      ok: false,
      code: 'not_found',
    })
    expect(
      await run('update_skill', admin.port, { id: 'w1', source: 'workspace', name: 'X' }),
    ).toMatchObject({ ok: false, code: 'permission_denied' })
    expect(await run('update_skill', admin.port, { id: 'v1' })).toMatchObject({
      ok: false,
      code: 'invalid_input',
    })
  })

  it('deletes a vault skill and guards workspace and absent targets', async () => {
    const admin = fakeSkillAdmin()
    admin.seed(entry({ id: 'v1' }))

    expect(await run('delete_skill', admin.port, { id: 'w1', source: 'workspace' })).toMatchObject({
      ok: false,
      code: 'permission_denied',
    })
    expect(await run('delete_skill', admin.port, { id: 'ghost' })).toMatchObject({
      ok: false,
      code: 'not_found',
    })
    expect(await run('delete_skill', admin.port, { id: 'v1' })).toMatchObject({ ok: true, code: 'ok' })
    expect(admin.entries.get('vault:v1')).toBeUndefined()
  })
})
