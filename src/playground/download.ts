import { REMOTE_BINARY_CAP } from '../ui/file-view/load'
import { PlaygroundError } from './errors'

export interface DownloadOptions {
  fetch?: typeof fetch
  signal?: AbortSignal
  maxBytes?: number
  fallbackUrl?: string
  retryDelaysMs?: readonly number[]
}

export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000]

const RETRY_STATUSES = new Set([502, 503, 504])

const NETWORK_MESSAGE =
  'The image could not be downloaded. The file host may be unreachable from this network.'

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function networkError(error: unknown): unknown {
  if (isAbort(error) || error instanceof PlaygroundError) return error
  return new PlaygroundError('network', NETWORK_MESSAGE, { cause: error })
}

function tooLarge(maxBytes: number): PlaygroundError {
  const megabytes = Math.round(maxBytes / (1024 * 1024))
  return new PlaygroundError('too_large', `The image is larger than the ${megabytes} MB download limit.`)
}

async function readCapped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array[]> {
  const reader = body.getReader()
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined)
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) return chunks
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw tooLarge(maxBytes)
      }
      chunks.push(value)
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

async function readImage(
  response: Response,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<{ blob: Blob; mime: string }> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    throw new PlaygroundError('http', `The file host returned HTTP ${response.status}.`, {
      status: response.status,
    })
  }
  const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!mime.startsWith('image/')) {
    void response.body?.cancel().catch(() => undefined)
    throw new PlaygroundError('unsupported_output', 'The output is not an image.')
  }
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > maxBytes) {
    void response.body?.cancel().catch(() => undefined)
    throw tooLarge(maxBytes)
  }
  if (!response.body) {
    const blob = await response.blob()
    if (blob.size > maxBytes) throw tooLarge(maxBytes)
    return { blob: new Blob([blob], { type: mime }), mime }
  }
  const chunks = await readCapped(response.body, maxBytes, signal)
  return { blob: new Blob(chunks as BlobPart[], { type: mime }), mime }
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof PlaygroundError)) return false
  return error.code === 'network' || (error.code === 'http' && RETRY_STATUSES.has(error.status ?? 0))
}

function finalError(error: unknown): unknown {
  if (error instanceof PlaygroundError && error.code === 'http' && RETRY_STATUSES.has(error.status ?? 0)) {
    return new PlaygroundError(
      'network',
      `The file host could not be reached (HTTP ${error.status}) after several tries. The network may be blocking it; try again later or from another connection.`,
      { status: error.status, cause: error },
    )
  }
  return error
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function attempt(
  url: string,
  fetchImpl: typeof fetch,
  maxBytes: number,
  options: DownloadOptions,
): Promise<{ blob: Blob; mime: string }> {
  const init: RequestInit = { credentials: 'omit', signal: options.signal }
  let response: Response
  try {
    response = await fetchImpl(url, init)
  } catch (error) {
    if (!(error instanceof TypeError) || !options.fallbackUrl) throw networkError(error)
    try {
      response = await fetchImpl(options.fallbackUrl, init)
    } catch (fallbackError) {
      throw networkError(fallbackError)
    }
  }
  try {
    return await readImage(response, maxBytes, options.signal)
  } catch (error) {
    if (error instanceof TypeError) throw networkError(error)
    throw error
  }
}

export async function downloadImage(
  url: string,
  options: DownloadOptions = {},
): Promise<{ blob: Blob; mime: string }> {
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const maxBytes = options.maxBytes ?? REMOTE_BINARY_CAP
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  for (let index = 0; ; index += 1) {
    try {
      return await attempt(url, fetchImpl, maxBytes, options)
    } catch (error) {
      if (index >= delays.length || !isRetryable(error)) throw finalError(error)
      await wait(delays[index], options.signal)
    }
  }
}
