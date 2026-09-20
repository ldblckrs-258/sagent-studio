import { beforeEach, describe, expect, it } from 'vitest'
import { targetKey, useFileViewStore } from './file-view-state'

describe('file view store', () => {
  beforeEach(() =>
    useFileViewStore.setState({ target: null, revision: 0, authored: new Set<string>() }),
  )

  it('opens a workspace file', () => {
    useFileViewStore.getState().openWorkspace('docs/readme.md')
    expect(useFileViewStore.getState().target).toEqual({
      kind: 'workspace',
      path: 'docs/readme.md',
    })
  })

  it('opens a link and clears it', () => {
    const url = 'https://example.test/photo.png'
    useFileViewStore.getState().openUrl(url)
    expect(useFileViewStore.getState().target).toEqual({ kind: 'url', url })

    useFileViewStore.getState().clear()
    expect(useFileViewStore.getState().target).toBeNull()
  })

  it('treats a user re-open of the active path as a no-op', () => {
    const store = useFileViewStore.getState()
    store.openWorkspace('docs/readme.md')
    const revision = useFileViewStore.getState().revision

    useFileViewStore.getState().openWorkspace('docs/readme.md')
    expect(useFileViewStore.getState().revision).toBe(revision)
  })

  it('increments the revision for a different user path', () => {
    useFileViewStore.getState().openWorkspace('docs/readme.md')
    const revision = useFileViewStore.getState().revision

    useFileViewStore.getState().openWorkspace('docs/other.md')
    expect(useFileViewStore.getState().revision).toBe(revision + 1)
  })

  it('marks authorship and always reloads on a model open', () => {
    useFileViewStore.getState().presentWorkspace('artifacts/report.html')
    const first = useFileViewStore.getState()
    expect(first.target).toEqual({ kind: 'workspace', path: 'artifacts/report.html' })
    expect(first.authored.has('artifacts/report.html')).toBe(true)

    const revision = first.revision
    useFileViewStore.getState().presentWorkspace('artifacts/report.html')
    expect(useFileViewStore.getState().revision).toBe(revision + 1)
  })

  it('keys the same no-op path identically and a reload differently', () => {
    useFileViewStore.getState().openWorkspace('docs/readme.md')
    const state = useFileViewStore.getState()
    const key = targetKey(state.target, state.revision)

    useFileViewStore.getState().openWorkspace('docs/readme.md')
    const after = useFileViewStore.getState()
    expect(targetKey(after.target, after.revision)).toBe(key)

    useFileViewStore.getState().presentWorkspace('docs/readme.md')
    const reloaded = useFileViewStore.getState()
    expect(targetKey(reloaded.target, reloaded.revision)).not.toBe(key)
  })

  it('keeps a URL key independent of the revision', () => {
    useFileViewStore.getState().openUrl('https://example.test/a.html')
    expect(targetKey(useFileViewStore.getState().target, 0)).toBe('url:https://example.test/a.html')
    expect(targetKey(null, 9)).toBe('none')
  })

  it('canonicalizes a path so an alias cannot bypass sticky authorship', () => {
    useFileViewStore.getState().presentWorkspace('./artifacts/report.html')
    const presented = useFileViewStore.getState()
    expect(presented.target).toEqual({ kind: 'workspace', path: 'artifacts/report.html' })
    expect(presented.authored.has('artifacts/report.html')).toBe(true)

    useFileViewStore.getState().openWorkspace('artifacts/report.html')
    const reopened = useFileViewStore.getState()
    expect(reopened.target).toEqual({ kind: 'workspace', path: 'artifacts/report.html' })
    expect(reopened.authored.has('artifacts/report.html')).toBe(true)
  })
})
