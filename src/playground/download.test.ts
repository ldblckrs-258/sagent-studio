import { describe, expect, it, vi } from 'vitest'
import { downloadImage } from './download'

const NO_RETRY = { retryDelaysMs: [] as number[] }
import { PlaygroundError } from './errors'

function imageResponse(bytes: number, init: { type?: string; length?: boolean; status?: number } = {}): Response {
  const headers = new Headers({ 'content-type': init.type ?? 'image/webp' })
  if (init.length) headers.set('content-length', String(bytes))
  return new Response(new Uint8Array(bytes), { status: init.status ?? 200, headers })
}

function streamResponse(chunks: number[], type = 'image/png'): Response {
  let index = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) return controller.close()
      controller.enqueue(new Uint8Array(chunks[index++]))
    },
  })
  return new Response(body, { headers: { 'content-type': type } })
}

describe('downloadImage', () => {
  it('returns the bytes and the image type without sending cookies to the file host', async () => {
    const fetch = vi.fn(async () => imageResponse(10))
    const result = await downloadImage('https://replicate.delivery/a/out.webp', { fetch })
    expect(result.mime).toBe('image/webp')
    expect(result.blob.size).toBe(10)
    expect(fetch).toHaveBeenCalledWith('https://replicate.delivery/a/out.webp', expect.objectContaining({ credentials: 'omit' }))
  })

  it('retries through the same-origin fallback only when the direct fetch fails at the network layer', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(imageResponse(4))
    const result = await downloadImage('https://replicate.delivery/a/out.png', {
      fetch,
      fallbackUrl: '/replicate-files/_/a/out.png',
    })
    expect(result.blob.size).toBe(4)
    expect(fetch).toHaveBeenLastCalledWith('/replicate-files/_/a/out.png', expect.anything())
  })

  it('does not retry an HTTP error, because the host answered and the proxy would get the same answer', async () => {
    const fetch = vi.fn(async () => imageResponse(0, { status: 404 }))
    await expect(
      downloadImage('https://replicate.delivery/a/out.png', { fetch, fallbackUrl: '/replicate-files/_/a/out.png', retryDelaysMs: [0, 0] }),
    ).rejects.toMatchObject({ code: 'http', status: 404 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('maps a failed fallback to a network error instead of leaking a raw TypeError', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(
      downloadImage('https://replicate.delivery/a/out.png', { fetch, fallbackUrl: '/replicate-files/_/a/out.png', ...NO_RETRY }),
    ).rejects.toMatchObject({ code: 'network' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('rejects from content-length before reading, so an oversized output never fills memory', async () => {
    let pulls = 0
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1
          controller.enqueue(new Uint8Array(50))
        },
      },
      { highWaterMark: 0 },
    )
    const response = new Response(body, { headers: { 'content-type': 'image/png', 'content-length': '50' } })
    const fetch = vi.fn(async () => response)
    await expect(downloadImage('https://replicate.delivery/a.png', { fetch, maxBytes: 20 })).rejects.toMatchObject({
      code: 'too_large',
    })
    expect(pulls).toBe(0)
  })

  it('stops a streamed body as soon as it passes the cap, even without content-length', async () => {
    const fetch = vi.fn(async () => streamResponse([8, 8, 8, 8]))
    await expect(downloadImage('https://replicate.delivery/a.png', { fetch, maxBytes: 20 })).rejects.toMatchObject({
      code: 'too_large',
    })
  })

  it('refuses a non-image response, since only images are stored and rendered', async () => {
    const fetch = vi.fn(async () => imageResponse(5, { type: 'text/html' }))
    await expect(downloadImage('https://replicate.delivery/a.png', { fetch })).rejects.toBeInstanceOf(PlaygroundError)
    await expect(downloadImage('https://replicate.delivery/a.png', { fetch })).rejects.toMatchObject({
      code: 'unsupported_output',
    })
  })

  it('stops reading when the signal aborts, so Cancel and lock end a slow download', async () => {
    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new Uint8Array(4))
      },
    })
    const fetch = vi.fn(async () => new Response(body, { headers: { 'content-type': 'image/png' } }))
    const pending = downloadImage('https://replicate.delivery/a.png', { fetch, signal: controller.signal })
    setTimeout(() => controller.abort(new DOMException('Aborted', 'AbortError')), 5)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('retries a connection reset and a 502 from the relay, since some networks reset the file host intermittently', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(imageResponse(0, { status: 502 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(imageResponse(6))
    const result = await downloadImage('https://replicate.delivery/a/out.png', {
      fetch,
      fallbackUrl: '/replicate-files/_/a/out.png',
      retryDelaysMs: [0, 0, 0],
    })
    expect(result.blob.size).toBe(6)
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('explains a relay that keeps failing as an unreachable host instead of a bare HTTP 502', async () => {
    const fetch = vi.fn(async () => imageResponse(0, { status: 502 }))
    await expect(
      downloadImage('/replicate-r2/x', { fetch, retryDelaysMs: [0, 0] }),
    ).rejects.toMatchObject({ code: 'network', status: 502, message: expect.stringContaining('could not be reached') })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('stops retrying when the signal aborts during the backoff', async () => {
    const controller = new AbortController()
    const fetch = vi.fn(async () => {
      setTimeout(() => controller.abort(new DOMException('Aborted', 'AbortError')), 0)
      return imageResponse(0, { status: 503 })
    })
    await expect(
      downloadImage('/replicate-r2/x', { fetch, signal: controller.signal, retryDelaysMs: [50, 50] }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
