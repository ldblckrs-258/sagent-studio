import { beforeEach, describe, expect, it } from 'vitest'
import {
  autoAttachmentFor,
  autoAttachmentForThread,
  subscribeAttachmentThreadChanges,
  subscribeAutoTargetOwner,
  useAttachmentStore,
} from './attachment-store'
import { useFileViewStore } from '../session/file-view-state'
import { useChatStore } from './store'

function reset(): void {
  useAttachmentStore.setState({ items: {}, autoDisabled: {}, autoOwner: null })
  useFileViewStore.setState({ target: null, authored: new Set<string>() })
  useChatStore.setState({ activeThreadId: null })
}

/** Opens a file the way a tree click does, from a given conversation. */
function openFrom(threadId: string | null, path: string): void {
  useChatStore.setState({ activeThreadId: threadId })
  const stop = subscribeAutoTargetOwner()
  useFileViewStore.getState().openWorkspace(path)
  stop()
}

describe('attachment store', () => {
  beforeEach(reset)

  it('keeps the first source when the same path is attached twice', () => {
    const store = useAttachmentStore.getState()
    store.add('t1', { kind: 'file', path: 'a.ts', source: 'drag' })
    store.add('t1', { kind: 'file', path: 'a.ts', source: 'mention' })
    const items = useAttachmentStore.getState().items.t1
    expect(items).toHaveLength(1)
    expect(items[0].source).toBe('drag')
  })

  it('removes one chip by id', () => {
    useAttachmentStore.getState().add('t1', { kind: 'file', path: 'a.ts', source: 'drag' })
    const id = useAttachmentStore.getState().items.t1[0].id
    useAttachmentStore.getState().remove('t1', id)
    expect(useAttachmentStore.getState().items.t1).toHaveLength(0)
  })

  it('returns and clears the manual chips in one call', () => {
    const store = useAttachmentStore.getState()
    store.add('t1', { kind: 'file', path: 'a.ts', source: 'drag' })
    store.add('t1', { kind: 'folder', path: 'docs', source: 'mention' })
    const taken = useAttachmentStore.getState().take('t1')
    expect(taken.map((item) => item.path)).toEqual(['a.ts', 'docs'])
    expect(useAttachmentStore.getState().items.t1).toEqual([])
  })

  it('keeps each thread list separate', () => {
    const store = useAttachmentStore.getState()
    store.add('t1', { kind: 'file', path: 'a.ts', source: 'drag' })
    store.add('t2', { kind: 'file', path: 'b.ts', source: 'drag' })
    expect(useAttachmentStore.getState().items.t1).toHaveLength(1)
    expect(useAttachmentStore.getState().take('t2').map((item) => item.path)).toEqual([
      'b.ts',
    ])
  })

  it('drops the previous thread chips on a real conversation switch', () => {
    useChatStore.setState({ activeThreadId: 't1' })
    const unsubscribe = subscribeAttachmentThreadChanges()
    useAttachmentStore.getState().add('t1', {
      kind: 'file',
      path: 'a.ts',
      source: 'drag',
    })

    useChatStore.setState({ activeThreadId: 't2' })
    expect(useAttachmentStore.getState().items.t1).toBeUndefined()
    unsubscribe()
    useChatStore.setState({ activeThreadId: null })
  })

  it('hands the pre-thread chips to the thread the first send creates', () => {
    useChatStore.setState({ activeThreadId: null })
    const unsubscribe = subscribeAttachmentThreadChanges()
    useAttachmentStore.getState().add('', { kind: 'file', path: 'a.ts', source: 'drag' })
    useAttachmentStore.getState().disableAuto('')

    useChatStore.setState({ activeThreadId: 't1' })
    const state = useAttachmentStore.getState()
    expect(state.items['']).toBeUndefined()
    expect(state.items.t1.map((item) => item.path)).toEqual(['a.ts'])
    // A dismissed auto chip must not come back just because the thread now has
    // an id.
    expect(state.autoDisabled.t1).toBe(true)
    unsubscribe()
    useChatStore.setState({ activeThreadId: null })
  })
})

describe('autoAttachmentFor', () => {
  beforeEach(reset)

  it('follows a file the user opened', () => {
    const chip = autoAttachmentFor({ kind: 'workspace', path: 'README.md' }, new Set())
    expect(chip).toMatchObject({ path: 'README.md', source: 'auto', kind: 'file' })
  })

  it('ignores a file the model presented', () => {
    // `open_preview` is ungated in every mode, so a model-initiated open must
    // never ride into the next user turn.
    expect(
      autoAttachmentFor({ kind: 'workspace', path: 'out.html' }, new Set(['out.html'])),
    ).toBeNull()
  })

  it('ignores a deny-listed path and a url target', () => {
    expect(autoAttachmentFor({ kind: 'workspace', path: '.env' }, new Set())).toBeNull()
    expect(
      autoAttachmentFor({ kind: 'url', url: 'https://example.com' }, new Set()),
    ).toBeNull()
  })

  it('stops following once the user removes the chip', () => {
    openFrom('t1', 'README.md')
    expect(autoAttachmentForThread('t1')).not.toBeNull()
    useAttachmentStore.getState().disableAuto('t1')
    expect(autoAttachmentForThread('t1')).toBeNull()
  })

  it('never follows the user into another conversation', () => {
    // The File panel is global while the workspace folder is per thread, so a
    // chip that crossed would point the model at another folder's path.
    openFrom('t1', 'src/config.ts')
    expect(autoAttachmentForThread('t1')).not.toBeNull()
    expect(autoAttachmentForThread('t2')).toBeNull()
  })

  it('lets the thread created by the first send keep the chip', () => {
    openFrom(null, 'README.md')
    useAttachmentStore.getState().adoptComposerThread('t1')
    expect(autoAttachmentForThread('t1')).not.toBeNull()
  })

  it('never follows a model preview through the thread helper', () => {
    useChatStore.setState({ activeThreadId: 't1' })
    const stop = subscribeAutoTargetOwner()
    useFileViewStore.getState().presentWorkspace('report.html')
    stop()
    expect(autoAttachmentForThread('t1')).toBeNull()
  })
})
