import type { ToolSet } from 'ai'
import { describe, expect, it } from 'vitest'
import { createFakeWorkspace } from '../../workspace/fake-handle'
import type { WorkspaceFs } from '../../workspace/fs'
import { createWorkspaceFs } from '../../workspace/fs'
import { ToolRegistry } from '../registry'
import { createCheckToolProvider } from './check'

const CALL = { toolCallId: 'call-1', messages: [], context: {} }

function build(initial: Record<string, string>): { toolSet: ToolSet; fs: WorkspaceFs } {
  const fake = createFakeWorkspace(initial)
  const fs = createWorkspaceFs(fake.handle)
  const registry = new ToolRegistry()
  registry.registerProvider(createCheckToolProvider())
  return { toolSet: registry.buildToolSet(undefined, { workspace: fs }), fs }
}

function executor(toolSet: ToolSet, name: string) {
  const execute = toolSet[name]?.execute
  if (!execute) throw new Error(`missing execute for ${name}`)
  return execute
}

describe('check tool', () => {
  it('reports a clean HTML file as ok', async () => {
    const { toolSet } = build({ 'index.html': '<div><script>const a = 1</script></div>' })
    await expect(
      executor(toolSet, 'check')({ path: 'index.html' }, CALL),
    ).resolves.toMatchObject({ ok: true, value: { kind: 'html', ok: true, errors: [] } })
  })

  it('accepts a p containing inline code', async () => {
    const { toolSet } = build({ 'index.html': '<p>Call <code>run()</code> to start.</p>' })
    await expect(
      executor(toolSet, 'check')({ path: 'index.html' }, CALL),
    ).resolves.toMatchObject({ ok: true, value: { ok: true, errors: [] } })
  })

  it('reports a missing local reference as an error', async () => {
    const { toolSet } = build({
      'index.html': '<head><link rel="stylesheet" href="style.css"></head>',
    })
    await expect(
      executor(toolSet, 'check')({ path: 'index.html' }, CALL),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        ok: false,
        errors: [{ message: expect.stringContaining('style.css') }],
      },
    })
  })

  it('reports invalid JSON', async () => {
    const { toolSet } = build({ 'data.json': '{ nope }' })
    await expect(
      executor(toolSet, 'check')({ path: 'data.json' }, CALL),
    ).resolves.toMatchObject({ ok: true, value: { kind: 'json', ok: false } })
  })

  it('fails with not_found for a missing file', async () => {
    const { toolSet } = build({})
    await expect(
      executor(toolSet, 'check')({ path: 'missing.html' }, CALL),
    ).resolves.toMatchObject({ ok: false, code: 'not_found' })
  })
})
