import { describe, expect, it } from 'vitest'
import type { ToolSet } from 'ai'
import { ToolRegistry } from '../registry'
import type { SkillLoadPort } from '../types'
import { UNTRUSTED_SKILL_NOTICE, createSkillToolProvider } from './skills'

const CALL = { toolCallId: 'call-1', messages: [], context: {} }

function executor(toolSet: ToolSet, name: string) {
  const execute = toolSet[name]?.execute
  if (!execute) throw new Error(`missing execute for ${name}`)
  return execute
}

function samplePort(): SkillLoadPort {
  const vault = {
    id: 's1',
    name: 'S1',
    description: 'D1',
    source: 'vault' as const,
    instructions: 'body-1',
  }
  const workspace = {
    id: 'ws',
    name: 'WS',
    description: 'DW',
    source: 'workspace' as const,
    instructions: 'ws-body',
  }
  const all = [vault, workspace]
  return {
    list: () =>
      all.map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description,
        source: entry.source,
      })),
    load: (id, source) =>
      all.find((entry) => entry.id === id && (source === undefined || entry.source === source)) ?? null,
  }
}

function build(port: SkillLoadPort | undefined) {
  const registry = new ToolRegistry()
  registry.registerProvider(createSkillToolProvider({ isEnabled: () => true }))
  return registry.buildToolSet(undefined, port ? { skills: port } : {})
}

describe('createSkillToolProvider', () => {
  it('contributes load_skill and search_skills and gates availability on the port', () => {
    const provider = createSkillToolProvider({ isEnabled: () => true })
    expect(provider.names).toEqual(['load_skill', 'search_skills'])
    expect(provider.isAvailable({})).toBe(false)
    expect(provider.isAvailable({ skills: { list: () => [], load: () => null } })).toBe(false)
    expect(provider.isAvailable({ skills: samplePort() })).toBe(true)
    expect(Object.keys(build(samplePort()))).toEqual(['load_skill', 'search_skills'])
  })

  it('searches the skill index by keyword', async () => {
    const set = build(samplePort())
    await expect(executor(set, 'search_skills')({ query: 'd1' }, CALL)).resolves.toMatchObject({
      ok: true,
      value: {
        scanned: 2,
        matched: 1,
        matches: [{ id: 's1', source: 'vault' }],
      },
    })
  })

  it('returns every skill for an empty query', async () => {
    const set = build(samplePort())
    await expect(executor(set, 'search_skills')({}, CALL)).resolves.toMatchObject({
      ok: true,
      value: { scanned: 2, matched: 2, matches: [{ id: 's1' }, { id: 'ws' }] },
    })
  })

  it('loads a vault skill as trusted', async () => {
    const set = build(samplePort())
    await expect(executor(set, 'load_skill')({ id: 's1' }, CALL)).resolves.toEqual({
      ok: true,
      code: 'ok',
      value: {
        id: 's1',
        name: 'S1',
        description: 'D1',
        source: 'vault',
        instructions: 'body-1',
        untrusted: false,
      },
    })
  })

  it('loads a workspace skill with the untrusted notice', async () => {
    const set = build(samplePort())
    await expect(executor(set, 'load_skill')({ id: 'ws', source: 'workspace' }, CALL)).resolves.toMatchObject({
      ok: true,
      value: { untrusted: true, notice: UNTRUSTED_SKILL_NOTICE, instructions: 'ws-body' },
    })
  })

  it('returns not_found with an available-ids hint', async () => {
    const set = build(samplePort())
    const result = (await executor(set, 'load_skill')({ id: 'nope' }, CALL)) as {
      ok: boolean
      code: string
      hint?: string
    }
    expect(result).toMatchObject({ ok: false, code: 'not_found' })
    expect(result.hint).toContain('s1')
    expect(result.hint).toContain('ws')
  })

  it('returns invalid_input for a missing, empty, or bad source', async () => {
    const set = build(samplePort())
    await expect(executor(set, 'load_skill')({}, CALL)).resolves.toMatchObject({
      ok: false,
      code: 'invalid_input',
    })
    await expect(executor(set, 'load_skill')({ id: '' }, CALL)).resolves.toMatchObject({
      ok: false,
      code: 'invalid_input',
    })
    await expect(
      executor(set, 'load_skill')({ id: 's1', source: 'other' }, CALL),
    ).resolves.toMatchObject({ ok: false, code: 'invalid_input' })
  })
})
