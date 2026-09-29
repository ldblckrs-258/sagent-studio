import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileTarget } from '../../session/file-view-state'
import { HtmlView } from './html-view'

/*
  The sandbox choice is the security-relevant branch this component owns: a path
  the model presented must never fall back to the same-origin `srcDoc` preview.
  The store and the document hook are stood in for so the assertion is on the
  rendered branch, not on file loading.
*/
const store = vi.hoisted(() => ({
  target: { kind: 'workspace', path: 'artifacts/report.html' },
  authored: new Set<string>(),
  terminal: undefined as { url: string; token: string } | undefined,
}))

vi.mock('../../vault/store', () => ({
  useVaultStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: { terminal: store.terminal } }),
}))

vi.mock('../../session/file-view-state', () => ({
  useFileViewStore: (selector: (state: unknown) => unknown) =>
    selector({ target: store.target, authored: store.authored }),
}))

vi.mock('./use-text-document', () => ({
  useTextDocument: () => ({
    draft: '<h1>hi</h1>',
    saved: '<h1>hi</h1>',
    dirty: false,
    loading: false,
    saving: false,
    error: null,
    byteLength: 11,
    setDraft: () => {},
    save: async () => {},
    revert: () => {},
  }),
}))

const TARGET: FileTarget = { kind: 'workspace', path: 'artifacts/report.html' }

function render(): string {
  return renderToStaticMarkup(<HtmlView fs={null} target={TARGET} />)
}

afterEach(() => {
  store.authored = new Set<string>()
  store.terminal = undefined
})

describe('HtmlView artifact sandbox', () => {
  it('routes a model-presented path to the opaque-origin runtime', () => {
    store.authored = new Set(['artifacts/report.html'])
    const html = render()
    expect(html).toContain('Loading artifact')
    expect(html).not.toContain('srcDoc')
    expect(html).not.toContain('allow-same-origin')
  })

  it('keeps the srcDoc preview for a user-opened path', () => {
    const html = render()
    expect(html).toContain('srcDoc')
    expect(html).toContain('allow-same-origin')
  })

  it('drops same-origin access for workspace previews while a terminal bridge is paired', () => {
    store.terminal = { url: 'ws://127.0.0.1:7717', token: 'tok_0123456789abcdef' }
    const html = render()
    expect(html).toContain('srcDoc')
    expect(html).not.toContain('allow-same-origin')
  })
})
