import { afterEach, describe, expect, it } from 'vitest'
import { capturePairingFragment, clearPendingPair, parseBridgeConfig, peekPendingPair, takePendingPair } from './pairing'

const TOKEN = 'tok_0123456789abcdef'

function fakeWindow(hash: string) {
  const replaced: string[] = []
  return {
    replaced,
    win: {
      location: { hash, pathname: '/app/', search: '?x=1' } as Location,
      history: {
        state: null,
        replaceState: (_state: unknown, _title: string, url: string) => replaced.push(url),
      } as unknown as History,
    },
  }
}

afterEach(() => clearPendingPair())

describe('capturePairingFragment', () => {
  it('captures a valid pair and strips the fragment so the token leaves the address bar and history', () => {
    const { win, replaced } = fakeWindow(`#sagent-bridge=${encodeURIComponent('ws://127.0.0.1:7717')}&token=${TOKEN}`)
    expect(capturePairingFragment(win)).toBe(true)
    expect(replaced).toEqual(['/app/?x=1'])
    expect(peekPendingPair()).toEqual({ url: 'ws://127.0.0.1:7717', token: TOKEN })
  })

  it('refuses remote hosts, wss and http, but still strips the fragment', () => {
    for (const url of ['ws://evil.com:7717', 'wss://127.0.0.1:7717', 'http://127.0.0.1:7717']) {
      const { win, replaced } = fakeWindow(`#sagent-bridge=${encodeURIComponent(url)}&token=${TOKEN}`)
      expect(capturePairingFragment(win)).toBe(false)
      expect(replaced).toHaveLength(1)
      expect(peekPendingPair()).toBeNull()
    }
  })

  it('ignores unrelated fragments', () => {
    const { win, replaced } = fakeWindow('#section-2')
    expect(capturePairingFragment(win)).toBe(false)
    expect(replaced).toEqual([])
  })

  it('clears the pending pair once taken, so a reload of the same tab does not reuse it', () => {
    const { win } = fakeWindow(`#sagent-bridge=${encodeURIComponent('ws://localhost:7717')}&token=${TOKEN}`)
    capturePairingFragment(win)
    expect(takePendingPair()).not.toBeNull()
    expect(takePendingPair()).toBeNull()
  })
})

it('parseBridgeConfig trims and validates manual input', () => {
  expect(parseBridgeConfig(' ws://127.0.0.1:7717 ', ` ${TOKEN} `)).toEqual({ url: 'ws://127.0.0.1:7717', token: TOKEN })
  expect(parseBridgeConfig('ws://127.0.0.1:7717/path', TOKEN)).toBeNull()
  expect(parseBridgeConfig('ws://127.0.0.1:7717', 'short')).toBeNull()
})
