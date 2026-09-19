import { describe, expect, it } from 'vitest'
import { createFakeWorkspace } from '../workspace/fake-handle'
import { createWorkspaceFs } from '../workspace/fs'
import { SkillRegistry } from './registry'
import type { SkillStore } from './registry'
import { createWorkspaceSkillSource } from './workspace-source'

function emptyStore(): SkillStore {
  return { save: async () => {}, remove: async () => {}, list: async () => [] }
}

describe('createWorkspaceSkillSource', () => {
  it('lists and parses .agents/skills entries', async () => {
    const fake = createFakeWorkspace({
      '.agents/skills/reviewer/SKILL.md': [
        '---',
        'name: Reviewer',
        'description: Review PRs',
        'allowed-tools: [read_file]',
        '---',
        'Check the diff.',
      ].join('\n'),
      '.agents/skills/notes.txt': 'not a skill directory',
    })
    const source = createWorkspaceSkillSource(createWorkspaceFs(fake.handle))

    const manifests = await source.list()
    expect(manifests).toHaveLength(1)
    expect(manifests[0]).toMatchObject({
      id: '.agents/skills/reviewer',
      name: 'Reviewer',
      description: 'Review PRs',
      source: 'workspace',
      allowedTools: ['read_file'],
      path: '.agents/skills/reviewer/SKILL.md',
    })
    expect(manifests[0].instructions).toBe('Check the diff.')
  })

  it('returns an empty list when the skills root is absent', async () => {
    const source = createWorkspaceSkillSource(
      createWorkspaceFs(createFakeWorkspace().handle),
    )
    await expect(source.list()).resolves.toEqual([])
  })

  it('skips a malformed skill without failing the listing', async () => {
    const fake = createFakeWorkspace({
      '.agents/skills/good/SKILL.md': ['---', 'name: Good', '---', 'Body'].join('\n'),
      '.agents/skills/bad/SKILL.md': ['---', 'name: [unclosed', '---', 'Body'].join('\n'),
    })
    const manifests = await createWorkspaceSkillSource(createWorkspaceFs(fake.handle)).list()
    expect(manifests.map((manifest) => manifest.id)).toEqual(['.agents/skills/good'])
  })

  it('registers workspace skills as untrusted and disabled', async () => {
    const fake = createFakeWorkspace({
      '.agents/skills/reviewer/SKILL.md': ['---', 'name: Reviewer', '---', 'Body'].join('\n'),
    })
    const registry = new SkillRegistry(emptyStore())
    await registry.loadWorkspaceSkills(
      createWorkspaceSkillSource(createWorkspaceFs(fake.handle)),
    )

    expect(registry.get({ id: '.agents/skills/reviewer', source: 'workspace' })).toBeDefined()
    expect(registry.isEnabled({ id: '.agents/skills/reviewer', source: 'workspace' })).toBe(false)
    expect(registry.resolve([{ id: '.agents/skills/reviewer', source: 'workspace' }])).toEqual([])
  })
})
