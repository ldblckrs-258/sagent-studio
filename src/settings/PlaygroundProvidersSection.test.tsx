// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVaultStore, vaultInternals } from '../vault/store'
import { PlaygroundProvidersSection } from './PlaygroundProvidersSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

async function mount() {
  const settings = useVaultStore.getState().settings
  if (!settings) throw new Error('vault is locked')
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<PlaygroundProvidersSection settings={settings} />)
  })
  return container
}

async function setValue(element: Element | null, value: string): Promise<void> {
  if (!(element instanceof HTMLInputElement)) throw new Error('missing input')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('missing element')
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.trim() === text)
}

describe('PlaygroundProvidersSection', () => {
  beforeEach(async () => {
    await vaultInternals.reset()
    useVaultStore.setState({ status: 'locked', settings: null, error: null })
    await useVaultStore.getState().setup('providers-password')
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('lists every registered provider with a link to create a token', async () => {
    const container = await mount()
    expect(container.querySelector('h3')?.textContent).toBe('Replicate')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://replicate.com/account/api-tokens')
    expect(container.querySelector('input[aria-label="Replicate base URL"]')?.getAttribute('placeholder')).toBe('/replicate')
  })

  it('shows the vault error for a base URL that could send the token to another origin', async () => {
    await useVaultStore.getState().setPlaygroundProvider('replicate', { apiKey: 'r8_token' })
    const container = await mount()
    await setValue(container.querySelector('input[aria-label="Replicate base URL"]'), '//evil.example')
    await wait(450)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('same-origin path')
    expect(useVaultStore.getState().settings?.playgroundProviders?.replicate?.baseURL).toBeUndefined()
  })

  it('saves a pasted token and removes the entry when the token is cleared', async () => {
    const container = await mount()
    await setValue(container.querySelector('input[name="playground-replicate-apiKey"]'), 'r8_new_token')
    await wait(450)
    expect(useVaultStore.getState().settings?.playgroundProviders).toEqual({ replicate: { apiKey: 'r8_new_token' } })
    await click(container.querySelector('button[aria-label="Reveal API key"]'))
    await setValue(container.querySelector('input[name="playground-replicate-apiKey"]'), '')
    await wait(450)
    expect(useVaultStore.getState().settings?.playgroundProviders).toBeUndefined()
  })

  it('checks the token against the provider and reports the account without echoing the token', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === '/replicate/v1/account'
        ? new Response('{"username":"someone"}', { status: 200 })
        : new Response('{"detail":"bad r8_token"}', { status: 401 }),
    )
    vi.stubGlobal('fetch', fetch)
    await useVaultStore.getState().setPlaygroundProvider('replicate', { apiKey: 'r8_token' })
    const container = await mount()
    await click(buttonByText(container, 'Check token'))
    await wait(10)
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Token works for someone.')

    fetch.mockResolvedValueOnce(new Response('{"detail":"bad r8_token"}', { status: 401 }))
    await click(buttonByText(container, 'Check token'))
    await wait(10)
    const message = container.querySelector('[role="status"]')?.textContent ?? ''
    expect(message).not.toContain('r8_token')
  })

  it('refuses to check a token against an unsafe base URL, so the token never goes to another origin', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await useVaultStore.getState().setPlaygroundProvider('replicate', { apiKey: 'r8_token' })
    const container = await mount()
    await setValue(container.querySelector('input[aria-label="Replicate base URL"]'), '//evil.example')
    await click(buttonByText(container, 'Check token'))
    await wait(10)
    expect(fetch).not.toHaveBeenCalled()
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Fix the base URL before checking the token.')
  })
})
