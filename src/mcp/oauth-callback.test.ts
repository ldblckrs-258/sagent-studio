import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MCP_OAUTH_CHANNEL,
  McpOAuthCallbackError,
  handleMcpOAuthCallback,
  mcpOAuthRedirectUrl,
  parseMcpOAuthCallback,
  waitForMcpOAuthCallback,
} from './oauth-callback'

afterEach(() => {
  vi.useRealTimers()
})

function fakeChannel() {
  const listeners: Array<(event: MessageEvent) => void> = []
  const posted: unknown[] = []
  let closed = false
  return {
    posted,
    get closed() {
      return closed
    },
    emit: (data: unknown) => {
      for (const listener of listeners) listener({ data } as MessageEvent)
    },
    channel: {
      postMessage: (data: unknown) => posted.push(data),
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.push(listener),
      close: () => {
        closed = true
      },
    } as unknown as BroadcastChannel,
  }
}

describe('mcpOAuthRedirectUrl', () => {
  it('keeps the app path so a deployment under a sub-path still receives the callback', () => {
    expect(mcpOAuthRedirectUrl({ origin: 'https://app.example.com', pathname: '/studio/' })).toBe(
      'https://app.example.com/studio/?mcp-oauth=callback',
    )
  })
})

describe('parseMcpOAuthCallback', () => {
  it('reads code and state that the authorization server appends', () => {
    expect(parseMcpOAuthCallback('?mcp-oauth=callback&code=abc&state=s1')).toEqual({
      state: 's1',
      code: 'abc',
      error: null,
      errorDescription: null,
    })
  })

  it('ignores ordinary app URLs so the app still mounts', () => {
    expect(parseMcpOAuthCallback('?code=abc&state=s1')).toBeNull()
    expect(parseMcpOAuthCallback('')).toBeNull()
  })
})

describe('handleMcpOAuthCallback', () => {
  it('relays the result to the opener tab and closes the popup without mounting the app', () => {
    const fake = fakeChannel()
    const close = vi.fn()
    const handled = handleMcpOAuthCallback(
      { close, location: { search: '?mcp-oauth=callback&code=c&state=s' } },
      (name) => {
        expect(name).toBe(MCP_OAUTH_CHANNEL)
        return fake.channel
      },
    )
    expect(handled).toBe(true)
    expect(fake.posted).toEqual([{ state: 's', code: 'c', error: null, errorDescription: null }])
    expect(close).toHaveBeenCalled()
    expect(fake.closed).toBe(true)
  })

  it('does nothing for a normal page load', () => {
    const create = vi.fn()
    expect(handleMcpOAuthCallback({ close: vi.fn(), location: { search: '' } }, create)).toBe(false)
    expect(create).not.toHaveBeenCalled()
  })
})

describe('waitForMcpOAuthCallback', () => {
  it('resolves with the code only for the matching state, so another tab cannot inject a code', async () => {
    const fake = fakeChannel()
    const pending = waitForMcpOAuthCallback({
      expectedState: 'mine',
      isPopupClosed: () => false,
      createChannel: () => fake.channel,
    })
    fake.emit({ state: 'other', code: 'forged', error: null, errorDescription: null })
    fake.emit({ state: 'mine', code: 'real', error: null, errorDescription: null })
    await expect(pending).resolves.toBe('real')
    expect(fake.closed).toBe(true)
  })

  it('rejects with the server error for the matching state', async () => {
    const fake = fakeChannel()
    const pending = waitForMcpOAuthCallback({
      expectedState: 'mine',
      isPopupClosed: () => false,
      createChannel: () => fake.channel,
    })
    fake.emit({ state: 'mine', code: null, error: 'access_denied', errorDescription: 'User said no' })
    await expect(pending).rejects.toThrow('The server refused sign-in (access_denied): User said no')
  })

  it('rejects when the user closes the popup, instead of waiting forever', async () => {
    vi.useFakeTimers()
    const fake = fakeChannel()
    let closed = false
    const pending = waitForMcpOAuthCallback({
      expectedState: 'mine',
      isPopupClosed: () => closed,
      createChannel: () => fake.channel,
    })
    const assertion = expect(pending).rejects.toBeInstanceOf(McpOAuthCallbackError)
    closed = true
    await vi.advanceTimersByTimeAsync(600)
    await assertion
    expect(fake.closed).toBe(true)
  })

  it('times out', async () => {
    vi.useFakeTimers()
    const fake = fakeChannel()
    const pending = waitForMcpOAuthCallback({
      expectedState: 'mine',
      isPopupClosed: () => false,
      timeoutMs: 1_000,
      createChannel: () => fake.channel,
    })
    const assertion = expect(pending).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(1_001)
    await assertion
  })
})
