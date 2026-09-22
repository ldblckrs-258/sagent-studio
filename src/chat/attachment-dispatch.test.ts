import { beforeEach, describe, expect, it } from 'vitest'
import { AttachmentsDroppedError, resolveSnapshot } from './use-chat-runtime'
import type { Attachment } from './attachments'
import type { AttachmentSnapshot } from './queue'
import { useChatStore } from './store'
import { useWorkspaceStore } from '../session/workspace-state'
import { createFakeWorkspace } from '../workspace/fake-handle'
import type { WorkspaceFs } from '../workspace/fs'
import { createWorkspaceFs } from '../workspace/fs'
import { createInlineSearchRunner } from '../workspace/search-runner'

function buildFs(initial: Record<string, string> = {}) {
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

function chip(path: string): Attachment {
  return { id: path, kind: 'file', path, source: 'drag' }
}

function snapshot(
  threadId: string,
  fs: WorkspaceFs | null,
  paths: string[],
): AttachmentSnapshot {
  return { threadId, fs, attachments: paths.map(chip) }
}

describe('resolveSnapshot', () => {
  beforeEach(() => {
    useChatStore.getState().setError(null)
  })

  it('resolves against the folder bound now', async () => {
    const fs = buildFs({ 'a.ts': 'const a = 1' })
    useWorkspaceStore.setState({ fs, boundThreadId: 't1' })
    const resolved = await resolveSnapshot(snapshot('t1', fs, ['a.ts']), 't1')
    expect(resolved?.items[0].record.mode).toBe('inline')
  })

  it('refuses a message whose conversation changed while it waited', async () => {
    const fs = buildFs({ 'a.ts': 'const a = 1' })
    useWorkspaceStore.setState({ fs, boundThreadId: 't2' })
    await expect(
      resolveSnapshot(snapshot('t1', fs, ['a.ts']), 't2'),
    ).rejects.toBeInstanceOf(AttachmentsDroppedError)
  })

  it('refuses when the folder itself was swapped under the message', async () => {
    // `bindThread` sets `boundThreadId` synchronously and adopts the new `fs`
    // only after an await, so a send inside that window would otherwise read
    // the previous conversation's folder.
    const typedIn = buildFs({ 'a.ts': 'const a = 1' })
    const boundNow = buildFs({ 'a.ts': 'const other = 2' })
    useWorkspaceStore.setState({ fs: boundNow, boundThreadId: 't1' })
    await expect(
      resolveSnapshot(snapshot('t1', typedIn, ['a.ts']), 't1'),
    ).rejects.toBeInstanceOf(AttachmentsDroppedError)
  })

  it('refuses when no folder is open at all', async () => {
    useWorkspaceStore.setState({ fs: null, boundThreadId: 't1' })
    await expect(
      resolveSnapshot(snapshot('t1', null, ['a.ts']), 't1'),
    ).rejects.toBeInstanceOf(AttachmentsDroppedError)
  })

  it('adopts chips captured before the session had a thread', async () => {
    const fs = buildFs({ 'a.ts': 'const a = 1' })
    useWorkspaceStore.setState({ fs, boundThreadId: 't1' })
    const resolved = await resolveSnapshot(snapshot('', fs, ['a.ts']), 't1')
    expect(resolved?.items).toHaveLength(1)
  })

  it('reports a failing chip without failing the turn', async () => {
    const fs = buildFs({ 'a.ts': 'const a = 1' })
    useWorkspaceStore.setState({ fs, boundThreadId: 't1' })
    const resolved = await resolveSnapshot(
      snapshot('t1', fs, ['gone.ts', 'a.ts']),
      't1',
    )
    expect(resolved?.items.map((item) => item.record.mode)).toEqual([
      'missing',
      'inline',
    ])
    expect(useChatStore.getState().error).toContain('gone.ts')
  })
})
