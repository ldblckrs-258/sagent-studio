// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatThread } from '../chat/types'
import { useChatStore } from '../chat/store'
import { useAgentPanelStore } from '../session/agent-panel-state'
import { VIEW_STATE_KEY, useShellView } from './shell-view'
import { ViewSwitch } from './view-switch'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Harness() {
  const { view, setView, pendingApprovalId } = useShellView()
  return (
    <>
      <ViewSwitch view={view} onChange={setView} chatBadge={pendingApprovalId !== null} />
      <output data-view>{view}</output>
    </>
  )
}

async function mount() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<Harness />)
  })
  return {
    container,
    view: () => container.querySelector('[data-view]')?.textContent,
    tab: (name: string) => Array.from(container.querySelectorAll('[role="tab"]')).find((tab) => tab.textContent === name),
    unmount: () => act(() => root.unmount()),
  }
}

function pendingThread(): ChatThread {
  return {
    id: 't1',
    messages: [
      {
        id: 'm1',
        role: 'assistant',
        parts: [{ type: 'tool-write_file', state: 'approval-requested', input: {}, approval: { id: 'ap-1' } }],
      },
    ],
  } as unknown as ChatThread
}

describe('shell view switch', () => {
  beforeEach(() => {
    sessionStorage.clear()
    useChatStore.setState({ threads: {}, activeThreadId: null })
    useAgentPanelStore.getState().clear()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('remembers the chosen view for the session', async () => {
    const ui = await mount()
    expect(ui.view()).toBe('chat')
    await act(async () => {
      ui.tab('Playground')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(ui.view()).toBe('playground')
    expect(sessionStorage.getItem(VIEW_STATE_KEY)).toBe('playground')
    ui.unmount()
    expect((await mount()).view()).toBe('playground')
  })

  it('falls back to chat when the stored value is not a known view', async () => {
    sessionStorage.setItem(VIEW_STATE_KEY, 'settings')
    expect((await mount()).view()).toBe('chat')
  })

  it('moves between tabs with the arrow keys', async () => {
    const ui = await mount()
    await act(async () => {
      ui.container.querySelector('[role="tablist"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(ui.view()).toBe('playground')
  })

  it('flags the Chat tab while an approval waits, so a request is not missed in Playground', async () => {
    sessionStorage.setItem(VIEW_STATE_KEY, 'playground')
    const ui = await mount()
    expect(ui.container.querySelector('[data-approval-badge]')).toBeNull()
    await act(async () => {
      useChatStore.setState({ threads: { t1: pendingThread() }, activeThreadId: 't1' })
    })
    expect(ui.container.querySelector('[data-approval-badge]')).not.toBeNull()
    expect(ui.tab('Chat')?.getAttribute('aria-label')).toBe('Chat (approval pending)')
  })

  it('returns to chat when an agent run is opened, since the run view lives there', async () => {
    sessionStorage.setItem(VIEW_STATE_KEY, 'playground')
    const ui = await mount()
    await act(async () => {
      useAgentPanelStore.getState().open('run-1')
    })
    expect(ui.view()).toBe('chat')
  })
})
