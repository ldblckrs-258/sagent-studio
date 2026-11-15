import { describe, expect, it, vi } from 'vitest'
import { CANCEL_AFTER, INLINE_IMAGE_BYTES, mapPrediction, replicateProvider } from './index'
import type { PlaygroundModel } from '../../types'

const TOKEN = 'r8_TestTokenValue0123456789'

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function setup(respond: (url: string, init: RequestInit) => Response | Promise<Response> = () => ok({})) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => respond(String(input), init ?? {}))
  const provider = replicateProvider.create({ apiKey: TOKEN, baseURL: '/replicate' }, { fetch })
  return { fetch, provider }
}

function call(fetch: ReturnType<typeof setup>['fetch'], index = 0): { url: string; init: RequestInit } {
  const [url, init] = fetch.mock.calls[index]
  return { url: String(url), init: init ?? {} }
}

const schemaModel = {
  is_official: true,
  description: 'Fast model',
  latest_version: {
    id: 'v123',
    openapi_schema: {
      components: {
        schemas: {
          Input: {
            required: ['prompt'],
            properties: {
              prompt: { type: 'string', 'x-order': 0 },
              input_image: { type: 'string', format: 'uri', 'x-order': 1 },
            },
          },
        },
      },
    },
  },
}

function model(ref: { isOfficial: boolean; versionId: string | null }): PlaygroundModel {
  return { providerId: 'replicate', slug: 'owner/name', label: 'owner/name', fields: [], editsImages: false, ref }
}

describe('replicate provider', () => {
  it('builds the form from the latest version schema and flags edit models', async () => {
    const { fetch, provider } = setup(() => ok(schemaModel))
    const result = await provider.getModel('black-forest-labs/flux-kontext-pro')
    expect(call(fetch).url).toBe('/replicate/v1/models/black-forest-labs/flux-kontext-pro')
    expect(result.fields.map((field) => field.name)).toEqual(['prompt', 'input_image'])
    expect(result.editsImages).toBe(true)
    expect(result.description).toBe('Fast model')
    expect(result.ref).toEqual({ isOfficial: true, versionId: 'v123' })
  })

  it('refuses a community model with no published version, since it cannot be run', async () => {
    const { provider } = setup(() => ok({ is_official: false, latest_version: null }))
    await expect(provider.getModel('someone/thing')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects a malformed slug before any request, so a path cannot escape the models endpoint', async () => {
    const { fetch, provider } = setup()
    await expect(provider.getModel('../x')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(provider.getModel('a/b/c')).rejects.toMatchObject({ code: 'invalid_input' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('starts official models by name and returns the id at once, capped server-side by Cancel-After', async () => {
    const { fetch, provider } = setup(() => ok({ id: 'p1', status: 'starting' }))
    const run = await provider.start(model({ isOfficial: true, versionId: 'v1' }), { prompt: 'x' })
    const { url, init } = call(fetch)
    const headers = init.headers as Record<string, string>
    expect(url).toBe('/replicate/v1/models/owner/name/predictions')
    expect(JSON.parse(String(init.body))).toEqual({ input: { prompt: 'x' } })
    expect(headers['Cancel-After']).toBe(CANCEL_AFTER)
    expect(headers.Prefer).toBeUndefined()
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(run).toEqual({ providerRunId: 'p1', status: 'starting' })
  })

  it('starts community models through the version endpoint with owner/name:version', async () => {
    const { fetch, provider } = setup(() => ok({ id: 'p2', status: 'starting' }))
    await provider.start(model({ isOfficial: false, versionId: 'abc' }), { prompt: 'x' })
    const { url, init } = call(fetch)
    expect(url).toBe('/replicate/v1/predictions')
    expect(JSON.parse(String(init.body))).toEqual({ version: 'owner/name:abc', input: { prompt: 'x' } })
  })

  it('polls and cancels by id against its own base, never following URLs from the response', async () => {
    const { fetch, provider } = setup(() =>
      ok({ id: 'p1', status: 'processing', urls: { get: 'https://evil.example/x', cancel: 'https://evil.example/y' } }),
    )
    await provider.poll('p1')
    await provider.cancel('p1')
    expect(call(fetch, 0).url).toBe('/replicate/v1/predictions/p1')
    expect(call(fetch, 1)).toMatchObject({ url: '/replicate/v1/predictions/p1/cancel', init: { method: 'POST' } })
    await expect(provider.poll('../account')).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('inlines small images and uploads larger ones through the files endpoint', async () => {
    const { fetch, provider } = setup(() => ok({ urls: { get: 'https://api.replicate.com/v1/files/f1' } }))
    const small = await provider.prepareImage(new Blob([new Uint8Array(10)], { type: 'image/png' }), 'a.png')
    expect(small).toMatch(/^data:image\/png;base64,/)
    expect(fetch).not.toHaveBeenCalled()
    const large = new Blob([new Uint8Array(INLINE_IMAGE_BYTES + 1)], { type: 'image/jpeg' })
    await expect(provider.prepareImage(large, 'b.jpg')).resolves.toBe('https://api.replicate.com/v1/files/f1')
    const { url, init } = call(fetch)
    expect(url).toBe('/replicate/v1/files')
    const form = init.body as FormData
    expect(form.get('content')).toBeInstanceOf(Blob)
    expect(form.get('filename')).toBe('b.jpg')
    expect(form.get('type')).toBe('image/jpeg')
  })

  it('rejects an input image over 25 MB before any request', async () => {
    const { fetch, provider } = setup()
    const huge = { size: 25 * 1024 * 1024 + 1, type: 'image/png' } as Blob
    await expect(provider.prepareImage(huge, 'huge.png')).rejects.toMatchObject({ code: 'too_large' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('downloads only from replicate.delivery over https, with an image-only proxy fallback', async () => {
    const { fetch, provider } = setup(() => {
      throw new TypeError('Failed to fetch')
    })
    await expect(provider.download({ url: 'https://evil.example/x.png' })).rejects.toMatchObject({ code: 'unsupported_output' })
    await expect(provider.download({ url: 'https://evil.r2.cloudflarestorage.com/x.png' })).rejects.toMatchObject({ code: 'unsupported_output' })
    await expect(provider.download({ url: 'http://replicate.delivery/x.png' })).rejects.toMatchObject({ code: 'unsupported_output' })
    expect(fetch).not.toHaveBeenCalled()

    vi.useFakeTimers()
    try {
      const requested = async (url: string) => {
        fetch.mockClear()
        const pending = provider.download({ url }).catch(() => undefined)
        await vi.runAllTimersAsync()
        await pending
        return fetch.mock.calls.map(([input]) => String(input))
      }
      expect(await requested('https://tjzk.replicate.delivery/a/out-0.webp')).toContain('/replicate-files/tjzk/a/out-0.webp')
      expect(await requested('https://replicate.delivery/xezq/out-0.png')).toContain('/replicate-files/_/xezq/out-0.png')
      const html = await requested('https://replicate.delivery/a/page.html')
      expect(html.some((url) => url.startsWith('/replicate-files'))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('replicate R2 outputs', () => {
  const account = '0d37909e38d3e99c29fa2cd343ac421a'
  const path = '/provider-outputs/01a173e5-a70f-75cb-9616-ee9bd8750cd9/5cdb166f-ba18-4803-a082-c6f6ed19b3db'
  const query = '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600&X-Amz-Signature=abc'

  it('downloads presigned R2 outputs through the same-origin proxy with the signature intact, since R2 sends no CORS headers', async () => {
    const { fetch, provider } = setup(() => new Response(new Uint8Array(4), { headers: { 'content-type': 'image/png' } }))
    const result = await provider.download({ url: `https://ai-gateway-outputs.${account}.r2.cloudflarestorage.com${path}${query}` })
    expect(result.mime).toBe('image/png')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(call(fetch).url).toBe(`/replicate-r2/${account}${path}${query}`)
  })

  it('refuses R2 links from other buckets or with unexpected paths, so the proxy stays narrow', async () => {
    const { fetch, provider } = setup()
    await expect(
      provider.download({ url: `https://other-bucket.${account}.r2.cloudflarestorage.com${path}${query}` }),
    ).rejects.toMatchObject({ code: 'unsupported_output' })
    await expect(
      provider.download({ url: `https://ai-gateway-outputs.${account}.r2.cloudflarestorage.com/page.html${query}` }),
    ).rejects.toMatchObject({ code: 'unsupported_output' })
    await expect(
      provider.download({ url: `https://ai-gateway-outputs.${account}.r2.cloudflarestorage.com${path}` }),
    ).rejects.toMatchObject({ code: 'unsupported_output' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('mapPrediction', () => {
  it.each([
    ['starting', 'starting'],
    ['processing', 'processing'],
    ['succeeded', 'succeeded'],
    ['failed', 'failed'],
    ['canceled', 'canceled'],
    ['aborted', 'canceled'],
  ])('maps status %s to %s', (status, expected) => {
    expect(mapPrediction({ id: 'p', status }, TOKEN).status).toBe(expected)
  })

  it('reads single and array uri outputs as images and anything else as JSON', () => {
    expect(mapPrediction({ id: 'p', status: 'succeeded', output: 'https://replicate.delivery/a.png' }, TOKEN).outputs).toEqual([
      { url: 'https://replicate.delivery/a.png' },
    ])
    expect(
      mapPrediction({ id: 'p', status: 'succeeded', output: ['https://replicate.delivery/a.png', 'https://replicate.delivery/b.png'] }, TOKEN)
        .outputs,
    ).toHaveLength(2)
    expect(mapPrediction({ id: 'p', status: 'succeeded', output: { text: 'hi' } }, TOKEN)).toMatchObject({
      outputJson: { text: 'hi' },
    })
    expect(mapPrediction({ id: 'p', status: 'succeeded', output: 'plain text' }, TOKEN).outputJson).toBe('plain text')
  })

  it('keeps the error and predict time but never copies the echoed input', () => {
    const run = mapPrediction(
      { id: 'p', status: 'failed', error: `bad ${TOKEN}`, metrics: { predict_time: 1.5 }, input: { openai_api_key: 'sk-live' } },
      TOKEN,
    )
    expect(run.predictTime).toBe(1.5)
    expect(run.error).not.toContain(TOKEN)
    expect(JSON.stringify(run)).not.toContain('sk-live')
  })
})
