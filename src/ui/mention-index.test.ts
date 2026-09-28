import { describe, expect, it } from 'vitest'
import {
  directoryEntries,
  mcpMentionEntries,
  mentionIndex,
  rankEntries,
  scopeOfQuery,
  searchByName,
} from './mention-index'
import type { MentionEntry } from './mention-index'
import { createFakeWorkspace } from '../workspace/fake-handle'
import type { WorkspaceFs } from '../workspace/fs'
import { createWorkspaceFs } from '../workspace/fs'
import { createInlineSearchRunner } from '../workspace/search-runner'

function buildFs(initial: Record<string, string>) {
  const fake = createFakeWorkspace(initial)
  const ref: { fs?: WorkspaceFs } = {}
  const searchRunner = createInlineSearchRunner({
    list: (path, options) => (ref.fs as WorkspaceFs).list(path, options),
    readFile: (path) => (ref.fs as WorkspaceFs).readFile(path),
  })
  const fs = createWorkspaceFs(fake.handle, { searchRunner })
  ref.fs = fs
  return fs
}

function entry(path: string, kind: 'file' | 'directory' = 'file'): MentionEntry {
  return { path, name: path.split('/').pop() ?? path, kind }
}

describe('mentionIndex', () => {
  it('omits vendor directories, dot-directories, and secrets', async () => {
    const fs = buildFs({
      'src/chat/engine.ts': 'x',
      'node_modules/pkg/index.js': 'x',
      '.cache/data.json': 'x',
      'dist/bundle.js': 'x',
      '.env': 'x',
      'certs/site.pem': 'x',
      'README.md': 'x',
    })
    const index = await mentionIndex(fs)
    const paths = index.entries.map((item) => item.path)
    expect(paths).toContain('src/chat/engine.ts')
    expect(paths).toContain('README.md')
    expect(paths.some((path) => path.startsWith('node_modules'))).toBe(false)
    expect(paths.some((path) => path.startsWith('.cache'))).toBe(false)
    expect(paths.some((path) => path.startsWith('dist'))).toBe(false)
    expect(paths).not.toContain('.env')
    expect(paths).not.toContain('certs/site.pem')
  })

  it('still offers source paths in a repository with a large vendor tree', async () => {
    const seeded: Record<string, string> = { 'src/chat/engine.ts': 'x' }
    // `node_modules` sorts before `src`, and the recursive walk spends its
    // 1000-entry budget as it goes: filtering afterwards would leave the index
    // holding nothing but whatever junk happened to sort first.
    for (let index = 0; index < 1200; index += 1) {
      seeded[`node_modules/pkg/f${index}.js`] = 'x'
    }
    const fs = buildFs(seeded)
    const index = await mentionIndex(fs)
    expect(index.entries.map((item) => item.path)).toContain('src/chat/engine.ts')
    expect(index.truncated).toBe(false)
  })

  it('hides OS bookkeeping files and sandbox scratch', async () => {
    const fs = buildFs({
      '.DS_Store': 'x',
      'src/a.ts': 'x',
      'dist/out.js': 'x',
    })
    const index = await mentionIndex(fs)
    expect(index.entries.map((item) => item.path)).toEqual(['src', 'src/a.ts'])
  })

  it('caches one index per folder', async () => {
    const fs = buildFs({ 'a.ts': 'x' })
    expect(await mentionIndex(fs)).toBe(await mentionIndex(fs))
  })
})

describe('rankEntries', () => {
  it('prefers a basename prefix over a deeper containing path', () => {
    const entries = [
      entry('vendor/lib/strange-engineering/util.ts'),
      entry('src/chat/engine.ts'),
    ]
    expect(rankEntries(entries, 'eng')[0].path).toBe('src/chat/engine.ts')
  })

  it('falls back to a subsequence and keeps the shorter path first', () => {
    const entries = [entry('src/very/deep/e-n-g.ts'), entry('e.n.g.ts')]
    expect(rankEntries(entries, 'eng').map((item) => item.path)).toEqual([
      'e.n.g.ts',
      'src/very/deep/e-n-g.ts',
    ])
  })

  it('returns tree order, capped, for an empty query', () => {
    const entries = [entry('a.ts'), entry('b.ts'), entry('c.ts')]
    expect(rankEntries(entries, '', 2).map((item) => item.path)).toEqual([
      'a.ts',
      'b.ts',
    ])
  })
})

describe('searchByName', () => {
  it('finds a file the capped index never reached', async () => {
    const seeded: Record<string, string> = {}
    for (let index = 0; index < 1100; index += 1) {
      seeded[`bulk/f${index}.ts`] = 'x'
    }
    seeded['zz-late/needle.ts'] = 'x'
    const fs = buildFs(seeded)

    const index = await mentionIndex(fs)
    expect(index.entries.some((item) => item.name === 'needle.ts')).toBe(false)

    const found = await searchByName(fs, 'needle')
    expect(found.map((item) => item.path)).toContain('zz-late/needle.ts')
  })

  it('never returns a deny-listed path', async () => {
    const fs = buildFs({ '.env.local': 'x', 'src/env-utils.ts': 'x' })
    const found = await searchByName(fs, 'env')
    expect(found.map((item) => item.path)).toEqual(['src/env-utils.ts'])
  })
})

describe('browsing a named directory', () => {
  it('reaches a hidden folder the index deliberately skips', async () => {
    const fs = buildFs({
      '.opencode/agent.md': 'x',
      '.opencode/tool/run.ts': 'x',
      'src/a.ts': 'x',
    })
    // The index hides dot-directories so they do not crowd out ordinary files.
    const index = await mentionIndex(fs)
    expect(index.entries.some((item) => item.path.startsWith('.opencode'))).toBe(
      false,
    )

    // Naming one is a different act: the user has already chosen the folder.
    expect(scopeOfQuery('.op')).toBe('')
    const root = await directoryEntries(fs, '')
    expect(root.map((item) => item.path)).toContain('.opencode')

    expect(scopeOfQuery('.opencode/')).toBe('.opencode')
    const inside = await directoryEntries(fs, '.opencode')
    expect(inside.map((item) => item.path)).toEqual([
      '.opencode/agent.md',
      '.opencode/tool',
    ])
  })

  it('still hides secrets and OS junk inside a browsed directory', async () => {
    const fs = buildFs({ '.config/.env': 'x', '.config/.DS_Store': 'x', '.config/a.json': 'x' })
    const inside = await directoryEntries(fs, '.config')
    expect(inside.map((item) => item.path)).toEqual(['.config/a.json'])
  })

  it('leaves a plain search to the index', () => {
    expect(scopeOfQuery('eng')).toBeNull()
    expect(scopeOfQuery('src/chat/eng')).toBe('src/chat')
  })
})

describe('mcpMentionEntries', () => {
  it('lists resources of ready servers only, keyed by an mcp path the chip and highlight share', () => {
    const base = {
      config: {
        id: 'mcp_one',
        name: 'Docs',
        url: 'https://a.example.com',
        transport: 'auto' as const,
        auth: { kind: 'none' as const },
        enabled: true,
        disabledTools: [],
        timeoutMs: 1000,
      },
      catalog: {
        tools: [],
        prompts: [],
        resources: [{ uri: 'file:///readme.md', name: 'readme' }],
        resourceTemplates: [],
        truncated: [],
      },
      skippedTools: [],
    }
    const entries = mcpMentionEntries({
      servers: {
        mcp_one: { ...base, state: 'ready' },
        mcp_two: { ...base, config: { ...base.config, id: 'mcp_two', name: 'Off' }, state: 'error' },
      },
      order: ['mcp_one', 'mcp_two'],
      loaded: true,
      error: null,
    })
    expect(entries).toEqual([
      {
        path: 'mcp:Docs:file:///readme.md',
        name: 'readme',
        kind: 'mcp-resource',
        serverId: 'mcp_one',
        serverName: 'Docs',
        uri: 'file:///readme.md',
      },
    ])
    expect(rankEntries(entries, 'mcp')[0]?.name).toBe('readme')
  })
})
