// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useVaultStore, vaultInternals } from '../vault/store'
import { ProvidersPanel } from './ProvidersPanel'
import type { ProvidersSection } from './ProvidersPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Harness({ initial }: { initial: ProvidersSection }) {
  const [section, setSection] = useState(initial)
  return <ProvidersPanel section={section} onSectionChange={setSection} />
}

async function mount(initial: ProvidersSection = 'llm') {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<Harness initial={initial} />)
  })
  return container
}

function tab(container: HTMLElement, name: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((entry) =>
    entry.textContent?.startsWith(name),
  )
  if (!found) throw new Error(`missing tab ${name}`)
  return found
}

function visiblePanel(container: HTMLElement): HTMLElement {
  const panel = Array.from(container.querySelectorAll<HTMLElement>('[role="tabpanel"]')).find((entry) => !entry.hidden)
  if (!panel) throw new Error('no visible panel')
  return panel
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('ProvidersPanel', () => {
  beforeEach(async () => {
    await vaultInternals.reset()
    useVaultStore.setState({ status: 'locked', settings: null, error: null })
    await useVaultStore.getState().setup('providers-password')
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('separates LLM, TypeSafe, and Playground providers into sub-tabs, one visible at a time', async () => {
    const container = await mount()
    expect(Array.from(container.querySelectorAll('[role="tab"]')).map((entry) => entry.textContent)).toEqual([
      'LLM',
      'TypeSafe',
      'Playground',
    ])
    expect(visiblePanel(container).textContent).toContain('LLM providers')
    await click(tab(container, 'TypeSafe'))
    expect(visiblePanel(container).querySelector('h2')?.textContent).toBe('TypeSafe')
    await click(tab(container, 'Playground'))
    expect(visiblePanel(container).querySelector('h2')?.textContent).toBe('Playground providers')
    expect(tab(container, 'Playground').getAttribute('aria-selected')).toBe('true')
  })

  it('opens on the requested sub-tab, so the Playground can link straight to its tokens', async () => {
    const container = await mount('playground')
    expect(visiblePanel(container).querySelector('h2')?.textContent).toBe('Playground providers')
  })

  it('shows which provider types are configured on the tabs themselves', async () => {
    await useVaultStore.getState().setPlaygroundProvider('replicate', { apiKey: 'r8_token' })
    const container = await mount()
    expect(tab(container, 'Playground').textContent).toBe('Playground1')
    expect(tab(container, 'LLM').textContent).toBe('LLM')
  })

  it('keeps an unsaved provider draft when switching sub-tabs and back', async () => {
    const container = await mount()
    const add = Array.from(container.querySelectorAll('button')).find((entry) => entry.textContent === 'Add provider')
    await click(add!)
    const label = visiblePanel(container).querySelector('input[placeholder="Local llama.cpp"]') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(label, 'Draft endpoint')
      label.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(tab(container, 'TypeSafe'))
    await click(tab(container, 'LLM'))
    expect((visiblePanel(container).querySelector('input[placeholder="Local llama.cpp"]') as HTMLInputElement).value).toBe(
      'Draft endpoint',
    )
  })

  it('moves between sub-tabs with the arrow keys', async () => {
    const container = await mount()
    await act(async () => {
      tab(container, 'LLM').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    expect(tab(container, 'Playground').getAttribute('aria-selected')).toBe('true')
  })
})
