// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useMemoryStore } from '../../memory/state'
import { MEMORY_IMPORTANT_BUDGET } from '../../memory/types'
import { useWorkspaceStore } from '../../session/workspace-state'
import { deriveKey, randomBytes } from '../../vault/crypto'
import { db } from '../../vault/db'
import * as keyring from '../../vault/keyring'
import { resolveApprovalStatus } from '../../tools/approval'
import { defaultSettings } from '../../vault/settings'
import { useVaultStore } from '../../vault/store'
import type { WorkspaceFs } from '../../workspace/fs'
import { MemoryPanel } from './memory'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const KDF = { algorithm: 'PBKDF2-SHA256' as const, iterations: 1000, salt: randomBytes(16) }

function folder(name: string): FileSystemDirectoryHandle {
  return { name, kind: 'directory' } as unknown as FileSystemDirectoryHandle
}

function useFolder(handle: FileSystemDirectoryHandle | null): void {
  useWorkspaceStore.getState().setFs(handle ? ({ handle } as unknown as WorkspaceFs) : null)
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return
    await settle()
  }
  throw new Error('Timed out waiting for the panel to settle.')
}

async function mount() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<MemoryPanel />)
  })
  await settle()
  return { container, unmount: () => act(() => root.unmount()) }
}

async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('missing element to click')
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}

async function type(element: Element | null, value: string): Promise<void> {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    throw new Error('missing text field')
  }
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function section(container: HTMLElement, label: string): HTMLElement | undefined {
  return [...container.querySelectorAll('section')].find(
    (node) => node.querySelector('.label-micro')?.textContent === label,
  )
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === text)
}

beforeEach(async () => {
  await db.memories.clear()
  await db.fs.clear()
  keyring.reset()
  keyring.install(await deriveKey('memory-panel-password', KDF))
  useVaultStore.setState({ settings: defaultSettings() })
  useMemoryStore.getState().clear()
  useFolder(null)
  await useMemoryStore.getState().hydrate()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('MemoryPanel', () => {
  it('groups memories by what the current conversation sees', async () => {
    const alpha = folder('alpha')
    const store = useMemoryStore.getState()
    await store.create({ title: 'Global note', body: 'g', scope: 'global' }, { source: 'user' })
    await store.create({ title: 'Alpha note', body: 'a', scope: 'workspace' }, { source: 'user', handle: alpha })
    await store.create(
      { title: 'Beta note', body: 'b', scope: 'workspace' },
      { source: 'user', handle: folder('beta') },
    )
    useFolder(alpha)

    const { container, unmount } = await mount()

    expect(section(container, 'Global')?.textContent).toContain('Global note')
    expect(section(container, 'Global')?.textContent).not.toContain('Alpha note')
    expect(section(container, 'This workspace')?.textContent).toContain('Alpha note')
    expect(section(container, 'This workspace')?.textContent).not.toContain('Beta note')
    expect(section(container, 'Other workspaces')?.textContent).toContain('Beta note')
    expect(section(container, 'Other workspaces')?.textContent).toContain('beta')
    unmount()
  })

  it('offers no workspace group or scope when no folder is granted', async () => {
    const { container, unmount } = await mount()

    expect(section(container, 'This workspace')).toBeUndefined()
    await click(buttonByText(container, 'Add'))
    const options = [...container.querySelectorAll('select[aria-label="Memory scope"] option')].map(
      (option) => (option as HTMLOptionElement).value,
    )
    expect(options).toEqual(['global'])
    unmount()
  })

  it('shows the budget error inline and keeps the form open', async () => {
    await useMemoryStore.getState().create(
      { title: 'Big', body: 'x'.repeat(MEMORY_IMPORTANT_BUDGET - 5), important: true, scope: 'global' },
      { source: 'user' },
    )
    const { container, unmount } = await mount()

    await click(buttonByText(container, 'Add'))
    await type(container.querySelector('input[aria-label="Memory title"]'), 'Extra')
    await type(container.querySelector('textarea[aria-label="Memory body"]'), 'more than five characters')
    await click(container.querySelector('button[role="switch"][aria-label="Important"]'))
    await click(buttonByText(container, 'Save'))
    await until(() => container.querySelector('[role="alert"]') !== null)

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Important memories in this scope would use',
    )
    expect(container.querySelector('input[aria-label="Memory title"]')).not.toBeNull()
    expect(await db.memories.count()).toBe(1)
    unmount()
  })

  it('saves a new memory as written by the user', async () => {
    const { container, unmount } = await mount()

    await click(buttonByText(container, 'Add'))
    await type(container.querySelector('input[aria-label="Memory title"]'), 'Editor')
    await type(container.querySelector('textarea[aria-label="Memory body"]'), 'Uses Helix.')
    await click(buttonByText(container, 'Save'))
    await until(() => useMemoryStore.getState().memories.length === 1)

    expect(useMemoryStore.getState().memories).toMatchObject([
      { title: 'Editor', body: 'Uses Helix.', source: 'user', scope: { kind: 'global' } },
    ])
    expect(section(container, 'Global')?.textContent).toContain('Editor')
    unmount()
  })

  it('deletes a memory only after the inline confirmation', async () => {
    await useMemoryStore.getState().create(
      { title: 'Doomed', body: 'old fact', scope: 'global' },
      { source: 'user' },
    )
    const { container, unmount } = await mount()

    await click(container.querySelector('button[aria-expanded]'))
    await click(container.querySelector('button[aria-label="Delete Doomed"]'))
    expect(await db.memories.count()).toBe(1)
    const dialog = container.querySelector('[role="alertdialog"]')
    await click(dialog ? buttonByText(dialog, 'Delete') : undefined)
    await until(async () => (await db.memories.count()) === 0)

    expect(container.textContent).not.toContain('Doomed')
    expect(await db.memories.count()).toBe(0)
    unmount()
  })

  it('lets the user stop the model from saving while it can still recall', async () => {
    const { container, unmount } = await mount()
    const toggle = () => container.querySelector('button[aria-label="Let the model save memories"]')
    expect(toggle()?.getAttribute('aria-checked')).toBe('true')

    await click(toggle())
    await until(() => toggle()?.getAttribute('aria-checked') === 'false')

    const policy = useVaultStore.getState().settings?.approvals
    for (const name of ['remember', 'update_memory', 'forget']) {
      expect(resolveApprovalStatus('god', policy, name), name).toBe('denied')
    }
    expect(resolveApprovalStatus('god', policy, 'recall_memory')).toBe('approved')

    await click(toggle())
    await until(() => toggle()?.getAttribute('aria-checked') === 'true')
    expect(resolveApprovalStatus('editing', useVaultStore.getState().settings?.approvals, 'remember')).toBe(
      'approved',
    )
    unmount()
  })

  it('marks what the model saved on its own', async () => {
    const store = useMemoryStore.getState()
    await store.create({ title: 'Model fact', body: 'm', scope: 'global' }, { source: 'model' })
    await store.create({ title: 'User fact', body: 'u', scope: 'global' }, { source: 'user' })
    const { container, unmount } = await mount()

    const rowOf = (title: string) =>
      [...container.querySelectorAll('li')].find((row) => row.textContent?.includes(title))
    expect(rowOf('Model fact')?.textContent).toContain('model')
    expect(rowOf('User fact')?.textContent).toContain('user')
    expect(rowOf('User fact')?.textContent).not.toContain('model')
    unmount()
  })
})
