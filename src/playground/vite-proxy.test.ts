import { describe, expect, it, vi } from 'vitest'
import {
  HARDENED_FILE_HEADERS,
  REPLICATE_API_PROXY_KEY,
  REPLICATE_FILES_PROXY_KEY,
  REPLICATE_R2_PROXY_KEY,
  replicateProxy,
} from '../../vite-proxy'

function viteMatches(key: string, url: string): boolean {
  return key[0] === '^' ? new RegExp(key).test(url) : url.startsWith(key)
}

function matchingKeys(url: string): string[] {
  return Object.keys(replicateProxy).filter((key) => viteMatches(key, url))
}

describe('dev proxy map', () => {
  it('routes API calls and file downloads to separate keys, so /replicate never swallows /replicate-files', () => {
    expect(matchingKeys('/replicate/v1/predictions')).toEqual([REPLICATE_API_PROXY_KEY])
    expect(matchingKeys('/replicate-files/tjzk/a/out-0.webp')).toEqual([REPLICATE_FILES_PROXY_KEY])
    expect(matchingKeys('/replicate-files/_/xezq/abc/out-0.png')).toEqual([REPLICATE_FILES_PROXY_KEY])
    expect(matchingKeys(`/replicate-r2/${'a'.repeat(32)}/provider-outputs/${'1'.repeat(36)}/${'2'.repeat(36)}?X-Amz-Signature=x`)).toEqual([
      REPLICATE_R2_PROXY_KEY,
    ])
  })

  it('proxies only image paths, so the app origin never serves model-authored HTML or SVG', () => {
    expect(matchingKeys('/replicate-files/tjzk/a/x.html')).toEqual([])
    expect(matchingKeys('/replicate-files/tjzk/a/x.svg')).toEqual([])
    expect(matchingKeys('/replicate-files/tjzk/../x.png')).toEqual([])
    expect(matchingKeys('/replicatefoo')).toEqual([])
    expect(matchingKeys('/replicate/v2/x')).toEqual([])
    expect(matchingKeys(`/replicate-r2/${'a'.repeat(32)}/other/${'1'.repeat(36)}/${'2'.repeat(36)}`)).toEqual([])
    expect(matchingKeys(`/replicate-r2/${'a'.repeat(31)}/provider-outputs/${'1'.repeat(36)}/${'2'.repeat(36)}`)).toEqual([])
    expect(matchingKeys(`/replicate-r2/${'a'.repeat(32)}/provider-outputs/${'1'.repeat(36)}/${'2'.repeat(36)}`)).toEqual([])
    expect(matchingKeys(`/replicate-r2/${'a'.repeat(32)}/provider-outputs/${'1'.repeat(36)}/${'2'.repeat(36)}?X-Amz-Date=1`)).toEqual([])
  })

  it('strips the /replicate prefix before forwarding to the API', () => {
    const rewrite = replicateProxy[REPLICATE_API_PROXY_KEY].rewrite
    expect(rewrite?.('/replicate/v1/account')).toBe('/v1/account')
  })

  it('sends each file request to its own replicate.delivery host and hardens the response', () => {
    const web = vi.fn()
    const handlers: Record<string, (proxyRes: { headers: Record<string, string> }) => void> = {}
    const proxy = { web, on: (event: string, handler: (proxyRes: { headers: Record<string, string> }) => void) => (handlers[event] = handler) }
    const configure = replicateProxy[REPLICATE_FILES_PROXY_KEY].configure as unknown as (p: typeof proxy, o: unknown) => void
    configure(proxy, {})

    const sub = { url: '/replicate-files/tjzk/models/cover.webp' }
    proxy.web(sub, {}, {})
    expect(sub.url).toBe('/models/cover.webp')
    expect(web).toHaveBeenLastCalledWith(sub, {}, { target: 'https://tjzk.replicate.delivery' })

    const apex = { url: '/replicate-files/_/xezq/out-0.png' }
    proxy.web(apex, {}, {})
    expect(web).toHaveBeenLastCalledWith(apex, {}, { target: 'https://replicate.delivery' })

    const proxyRes = { headers: { 'content-type': 'image/png', 'set-cookie': 'a=b' } as Record<string, string> }
    handlers.proxyRes(proxyRes)
    expect(proxyRes.headers['set-cookie']).toBeUndefined()
    expect(proxyRes.headers).toMatchObject(HARDENED_FILE_HEADERS)
  })

  it('sends R2 requests to the account host named in the path, keeping the signed query', () => {
    const web = vi.fn()
    const proxy = { web, on: vi.fn() }
    const configure = replicateProxy[REPLICATE_R2_PROXY_KEY].configure as unknown as (p: typeof proxy, o: unknown) => void
    configure(proxy, {})
    const account = 'b'.repeat(32)
    const req = { url: `/replicate-r2/${account}/provider-outputs/${'1'.repeat(36)}/${'2'.repeat(36)}?X-Amz-Signature=s` }
    proxy.web(req, {}, {})
    expect(req.url).toBe(`/provider-outputs/${'1'.repeat(36)}/${'2'.repeat(36)}?X-Amz-Signature=s`)
    expect(web).toHaveBeenLastCalledWith(req, {}, { target: `https://ai-gateway-outputs.${account}.r2.cloudflarestorage.com` })
    expect(proxy.on).toHaveBeenCalledWith('proxyRes', expect.any(Function))
  })
})
