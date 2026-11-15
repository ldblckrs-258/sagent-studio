import { describe, expect, it } from 'vitest'
import { groupRuns } from './run-groups'
import type { RunMeta } from './store'

function run(id: string, patch: Partial<RunMeta> = {}): RunMeta {
  return {
    id,
    providerId: 'replicate',
    model: 'black-forest-labs/flux-schnell',
    modelLabel: 'black-forest-labs/flux-schnell',
    input: { prompt: 'a cat', aspect_ratio: '1:1' },
    secretFields: [],
    inputImages: [],
    outputs: [],
    status: 'succeeded',
    bytes: 0,
    createdAt: 0,
    ...patch,
  }
}

describe('groupRuns', () => {
  it('groups runs whose settings match even when key order differs, keeping newest-first order', () => {
    const groups = groupRuns([
      run('c'),
      run('b', { input: { prompt: 'a dog' } }),
      run('a', { input: { aspect_ratio: '1:1', prompt: 'a cat' } }),
    ])
    expect(groups.map((group) => group.runs.map((entry) => entry.id))).toEqual([['c', 'a'], ['b']])
  })

  it('keeps runs apart when anything that changes the output differs', () => {
    const groups = groupRuns([
      run('base'),
      run('model', { model: 'google/imagen-4' }),
      run('version', { ref: { versionId: 'v2' } }),
      run('seed', { input: { prompt: 'a cat', aspect_ratio: '1:1', seed: 4 } }),
      run('image', { inputImages: [{ field: 'image', index: 0, name: 'cat.png', mime: 'image/png', size: 10 }] }),
      run('secret', { secretFields: ['api_key'] }),
    ])
    expect(groups).toHaveLength(6)
  })

  it('treats two different uploaded images as different settings, though both are stored as the same reference', () => {
    const image = (size: number) => [{ field: 'image', index: 0, name: 'in.png', mime: 'image/png', size }]
    const input = { prompt: 'edit', image: { $image: 0 } }
    expect(groupRuns([run('a', { input, inputImages: image(10) }), run('b', { input, inputImages: image(11) })])).toHaveLength(2)
  })
})
