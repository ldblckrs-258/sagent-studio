import { afterEach, describe, expect, it, vi } from 'vitest'
import { openBrowser } from './open-browser.js'
import { MAX_LIVE_CODES, PAIR_CODE_TTL_MS, PairCodes, pairRedirectLocation } from './pair.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('PairCodes', () => {
  it('is single use so a link seen in scrollback cannot pair twice', () => {
    const codes = new PairCodes()
    const code = codes.mint()
    expect(codes.consume(code)).toBe(true)
    expect(codes.consume(code)).toBe(false)
  })

  it('expires after ten minutes', () => {
    vi.useFakeTimers()
    const codes = new PairCodes()
    const code = codes.mint()
    vi.advanceTimersByTime(PAIR_CODE_TTL_MS)
    expect(codes.consume(code)).toBe(false)
  })

  it('keeps at most five live codes and drops the oldest', () => {
    const codes = new PairCodes()
    const first = codes.mint()
    for (let i = 0; i < MAX_LIVE_CODES; i++) codes.mint()
    expect(codes.size).toBe(MAX_LIVE_CODES)
    expect(codes.consume(first)).toBe(false)
  })

  it('rejects empty and unknown codes', () => {
    const codes = new PairCodes()
    expect(codes.consume(null)).toBe(false)
    expect(codes.consume('')).toBe(false)
    expect(codes.consume('nope')).toBe(false)
  })
})

describe('pairRedirectLocation', () => {
  it('puts the ws url and token only in the fragment, which browsers never send to a server', () => {
    const location = pairRedirectLocation('http://localhost:5173/', 'ws://127.0.0.1:7717', 'tok_abc')
    const url = new URL(location)
    expect(url.origin + url.pathname).toBe('http://localhost:5173/')
    expect(url.search).toBe('')
    const params = new URLSearchParams(url.hash.slice(1))
    expect(params.get('sagent-bridge')).toBe('ws://127.0.0.1:7717')
    expect(params.get('token')).toBe('tok_abc')
  })

  it('keeps the app path for hosted apps', () => {
    expect(pairRedirectLocation('https://x.dev/studio/', 'ws://127.0.0.1:1', 't')).toMatch(/^https:\/\/x\.dev\/studio\/#/)
  })
})

describe('openBrowser', () => {
  it('passes only the pair url as argv, with no shell', () => {
    const calls: { command: string; args: string[] }[] = []
    const spawn = (command: string, args: string[]) => {
      calls.push({ command, args })
      return { on: () => undefined, unref: () => undefined }
    }
    expect(openBrowser('http://127.0.0.1:7717/pair?code=c', 'darwin', spawn)).toBe(true)
    expect(openBrowser('http://127.0.0.1:7717/pair?code=c', 'linux', spawn)).toBe(true)
    expect(calls).toEqual([
      { command: 'open', args: ['http://127.0.0.1:7717/pair?code=c'] },
      { command: 'xdg-open', args: ['http://127.0.0.1:7717/pair?code=c'] },
    ])
    expect(openBrowser('x', 'win32', spawn)).toBe(false)
  })
})
