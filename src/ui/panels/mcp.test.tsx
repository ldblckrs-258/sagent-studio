// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { McpConnectionManager, emptyCatalog } from '../../mcp/manager'
import { memoryPersistence, serverConfig } from '../../mcp/test-fixtures'
import type { AppSession } from '../../session/session'
import { SessionContext } from '../../session/session-context'
import { McpPanel } from './mcp'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<() => void> = []

afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount()
})

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(manager: McpConnectionManager) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const session = { mcp: manager } as unknown as AppSession
  await act(async () => {
    root.render(
      <SessionContext.Provider value={session}>
        <McpPanel />
      </SessionContext.Provider>,
    )
  })
  await settle()
  mounted.push(() => {
    act(() => root.unmount())
    container.remove()
  })
  return container
}

async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('missing element to click')
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}

async function type(element: Element | null, value: string): Promise<void> {
  if (!(element instanceof HTMLInputElement)) throw new Error('missing text field')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function choose(element: Element | null, value: string): Promise<void> {
  if (!(element instanceof HTMLSelectElement)) throw new Error('missing select')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function button(container: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === text)
}

async function manager(configs = [serverConfig({ enabled: false })]) {
  const persistence = memoryPersistence(configs)
  const instance = new McpConnectionManager({ persistence })
  await instance.hydrate()
  return { instance, persistence }
}

describe('McpPanel', () => {
  it('shows validation errors from the manager, then saves a valid server', async () => {
    const { instance, persistence } = await manager([])
    const container = await mount(instance)
    expect(container.textContent).toContain('No MCP servers yet.')

    await click(button(container, 'Add'))
    await type(container.querySelector('[aria-label="Server name"]'), 'Docs')
    await type(container.querySelector('[aria-label="Server URL"]'), 'http://docs.example.com/mcp')
    await click(button(container, 'Save'))
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/must use https/)
    expect(persistence.entries.size).toBe(0)

    await type(container.querySelector('[aria-label="Server URL"]'), 'https://docs.example.com/mcp')
    await choose(container.querySelector('[aria-label="Transport"]'), 'sse')
    await click(button(container, 'Save'))
    const [saved] = [...persistence.entries.values()]
    expect(saved?.config).toMatchObject({ name: 'Docs', url: 'https://docs.example.com/mcp', transport: 'sse' })
    expect(container.querySelector('[data-mcp-server]')).not.toBeNull()
    await instance.dispose()
  })

  it('warns that a proxy sees every request, before the user saves one', async () => {
    const { instance } = await manager([])
    const container = await mount(instance)
    await click(button(container, 'Add'))
    expect(container.querySelector('[role="note"]')).toBeNull()
    await type(container.querySelector('[aria-label="Proxy URL"]'), 'https://proxy.example.com/')
    expect(container.querySelector('[role="note"]')?.textContent).toMatch(/including tokens and headers/)
    await instance.dispose()
  })

  it('shows each connection state and the reason, and offers sign-in only for OAuth servers', async () => {
    const { instance } = await manager([serverConfig({ auth: { kind: 'oauth' }, enabled: false })])
    const container = await mount(instance)
    await click(container.querySelector('[data-mcp-server] button[aria-expanded]'))
    expect(container.textContent).toContain('off')

    await act(async () => {
      instance.store.setState((state) => ({
        servers: {
          ...state.servers,
          mcp_one: {
            ...state.servers.mcp_one!,
            config: { ...state.servers.mcp_one!.config, enabled: true },
            state: 'needs-auth',
            reason: 'Sign in to this server to connect.',
          },
        },
      }))
    })
    expect(container.textContent).toContain('sign in')
    expect(container.textContent).toContain('Sign in to this server to connect.')
    expect(button(container, 'Sign in')).toBeDefined()

    await act(async () => {
      instance.store.setState((state) => ({
        servers: {
          ...state.servers,
          mcp_one: {
            ...state.servers.mcp_one!,
            config: { ...state.servers.mcp_one!.config, auth: { kind: 'none' } },
            state: 'error',
            reason: 'The browser could not reach the server.',
          },
        },
      }))
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('The browser could not reach the server.')
    expect(button(container, 'Sign in')).toBeUndefined()
    await instance.dispose()
  })

  it('persists a per-tool toggle, so a noisy tool stays out of the model tool list', async () => {
    const { instance, persistence } = await manager()
    await act(async () => {
      instance.store.setState((state) => ({
        servers: {
          ...state.servers,
          mcp_one: {
            ...state.servers.mcp_one!,
            state: 'ready',
            catalog: { ...emptyCatalog(), tools: [{ name: 'echo', inputSchema: { type: 'object' } }] },
          },
        },
      }))
    })
    const container = await mount(instance)
    await click(container.querySelector('[data-mcp-server] button[aria-expanded]'))
    expect(container.textContent).toContain('mcp_local_echo')
    await click(container.querySelector('[aria-label="Enable tool echo"]'))
    expect(persistence.entries.get('mcp_one')?.config.disabledTools).toEqual(['echo'])
    await instance.dispose()
  })

  it('asks before removing a server', async () => {
    const { instance, persistence } = await manager()
    const container = await mount(instance)
    await click(container.querySelector('[data-mcp-server] button[aria-expanded]'))
    await click(container.querySelector('[aria-label="Remove Local"]'))
    expect(persistence.entries.size).toBe(1)
    const dialog = container.querySelector('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('Remove “Local”?')
    await click(button(dialog!, 'Remove'))
    await settle()
    expect(persistence.entries.size).toBe(0)
    expect(container.textContent).toContain('No MCP servers yet.')
    await instance.dispose()
  })
})
