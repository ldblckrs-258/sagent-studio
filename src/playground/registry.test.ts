import { describe, expect, it, vi } from 'vitest'
import { listProviders, providerFor } from './registry'

describe('provider registry', () => {
  it('lists Replicate as the only provider in this version', () => {
    expect(listProviders().map((provider) => provider.id)).toEqual(['replicate'])
  })

  it('returns no provider without a stored token, so the view can show its empty state', () => {
    expect(providerFor('replicate', undefined)).toBeNull()
    expect(providerFor('replicate', { replicate: { apiKey: '  ' } })).toBeNull()
  })

  it('falls back to the same-origin proxy path when no base URL is stored', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{"username":"me"}', { status: 200 }))
    const provider = providerFor('replicate', { replicate: { apiKey: 'r8_x' } }, { fetch })
    await expect(provider?.verify()).resolves.toEqual({ account: 'me' })
    expect(fetch.mock.calls[0][0]).toBe('/replicate/v1/account')
  })
})
