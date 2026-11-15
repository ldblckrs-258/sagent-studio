import { toDataUrl } from '../../../chat/attachments'
import { MAX_UPLOAD_BYTES } from '../../../ui/composer-upload'
import { downloadImage } from '../../download'
import { PlaygroundError, redactToken, MAX_ERROR_MESSAGE } from '../../errors'
import { imageFields } from '../../form'
import { fieldsFromOpenApi, MAX_SCHEMA_TEXT } from '../../openapi-form'
import type { PlaygroundProvider, ProviderDefinition, ProviderDeps } from '../../provider'
import type {
  PlaygroundModel,
  PlaygroundProviderSettings,
  ProviderOutput,
  ProviderRun,
  RunStatus,
} from '../../types'
import { createReplicateHttp } from './client'

export const INLINE_IMAGE_BYTES = 256 * 1024
export const CANCEL_AFTER = '10m'

const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i
const PREDICTION_ID = /^[A-Za-z0-9_-]{1,128}$/
const DELIVERY_HOST = 'replicate.delivery'
const DELIVERY_SUBDOMAIN = /^[a-z0-9-]{1,32}$/
const IMAGE_PATH = /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:png|jpe?g|webp|gif|avif)$/
const R2_OUTPUT_HOST = /^ai-gateway-outputs\.([0-9a-f]{32})\.r2\.cloudflarestorage\.com$/
const R2_OUTPUT_PATH = /^\/provider-outputs\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/

export interface ReplicateModelRef {
  isOfficial: boolean
  versionId: string | null
}

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function splitSlug(slug: string): { owner: string; name: string } {
  const trimmed = slug.trim()
  if (!SLUG_PATTERN.test(trimmed)) {
    throw new PlaygroundError('invalid_input', 'Enter the model as owner/name, for example black-forest-labs/flux-schnell.')
  }
  const [owner, name] = trimmed.split('/')
  return { owner, name }
}

function modelPath(owner: string, name: string): string {
  return `/v1/models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

function predictionPath(id: string): string {
  if (!PREDICTION_ID.test(id)) throw new PlaygroundError('invalid_input', 'The prediction id is not valid.')
  return `/v1/predictions/${encodeURIComponent(id)}`
}

const STATUS: Record<string, RunStatus> = {
  starting: 'starting',
  processing: 'processing',
  succeeded: 'succeeded',
  failed: 'failed',
  canceled: 'canceled',
  aborted: 'canceled',
}

function isUri(value: unknown): value is string {
  return typeof value === 'string' && /^https:\/\//.test(value)
}

export function mapPrediction(body: unknown, token: string): ProviderRun {
  if (!isRecord(body) || typeof body.id !== 'string' || body.id === '') {
    throw new PlaygroundError('http', 'Replicate returned a prediction without an id.')
  }
  const run: ProviderRun = {
    providerRunId: body.id,
    status: (typeof body.status === 'string' && STATUS[body.status]) || 'processing',
  }
  const output = body.output
  if (isUri(output)) run.outputs = [{ url: output }]
  else if (Array.isArray(output) && output.length > 0 && output.every(isUri)) {
    run.outputs = output.map((url) => ({ url }))
  } else if (output !== null && output !== undefined) run.outputJson = output
  if (typeof body.error === 'string' && body.error.trim() !== '') {
    run.error = redactToken(body.error.trim(), token).slice(0, MAX_ERROR_MESSAGE)
  }
  const predictTime = isRecord(body.metrics) ? body.metrics.predict_time : undefined
  if (typeof predictTime === 'number' && Number.isFinite(predictTime)) run.predictTime = predictTime
  return run
}

export function deliveryFallback(url: URL): string | undefined {
  const sub =
    url.hostname === DELIVERY_HOST ? '_' : url.hostname.slice(0, -(DELIVERY_HOST.length + 1))
  if (!DELIVERY_SUBDOMAIN.test(sub) && sub !== '_') return undefined
  if (url.search !== '' || !IMAGE_PATH.test(url.pathname)) return undefined
  return `/replicate-files/${sub}${url.pathname}`
}

export function r2ProxyPath(url: URL): string | undefined {
  const match = R2_OUTPUT_HOST.exec(url.hostname)
  if (!match || !R2_OUTPUT_PATH.test(url.pathname) || !url.searchParams.has('X-Amz-Signature')) return undefined
  return `/replicate-r2/${match[1]}${url.pathname}${url.search}`
}

function outputUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new PlaygroundError('unsupported_output', 'The output link is not a valid URL.')
  }
  const host = url.hostname
  const delivery = host === DELIVERY_HOST || host.endsWith(`.${DELIVERY_HOST}`)
  if (url.protocol !== 'https:' || (!delivery && !R2_OUTPUT_HOST.test(host))) {
    throw new PlaygroundError('unsupported_output', 'The output is not hosted on a Replicate file host.')
  }
  return url
}

function createReplicate(config: PlaygroundProviderSettings, deps: ProviderDeps = {}): PlaygroundProvider {
  const token = config.apiKey
  const http = createReplicateHttp({
    apiKey: token,
    baseURL: config.baseURL ?? replicateProvider.defaultBaseURL,
    fetch: deps.fetch,
  })

  return {
    id: 'replicate',
    retentionMs: replicateProvider.retentionMs,

    async verify(signal) {
      const body = await http.request('GET', '/v1/account', { signal })
      const account = isRecord(body) && typeof body.username === 'string' ? body.username : ''
      return { account }
    },

    async getModel(slug, signal) {
      const { owner, name } = splitSlug(slug)
      const body = await http.request('GET', modelPath(owner, name), {
        signal,
        fallbacks: { not_found: `Replicate has no model named ${owner}/${name}.` },
      })
      if (!isRecord(body)) throw new PlaygroundError('http', 'Replicate returned an unreadable model.')
      const isOfficial = body.is_official === true
      const latest = isRecord(body.latest_version) ? body.latest_version : null
      const versionId = latest && typeof latest.id === 'string' && latest.id !== '' ? latest.id : null
      if (!isOfficial && !versionId) {
        throw new PlaygroundError('not_found', `${owner}/${name} has no published version to run.`)
      }
      const openapi = latest && isRecord(latest.openapi_schema) ? latest.openapi_schema : null
      const components = openapi && isRecord(openapi.components) ? openapi.components : null
      const schemas = components && isRecord(components.schemas) ? components.schemas : {}
      const fields = fieldsFromOpenApi(schemas.Input, schemas)
      const description =
        typeof body.description === 'string' && body.description.trim() !== ''
          ? body.description.trim().slice(0, MAX_SCHEMA_TEXT)
          : undefined
      const ref: ReplicateModelRef = { isOfficial, versionId }
      const model: PlaygroundModel = {
        providerId: 'replicate',
        slug: `${owner}/${name}`,
        label: `${owner}/${name}`,
        fields,
        editsImages: imageFields(fields).length > 0,
        ref,
      }
      if (description) model.description = description
      return model
    },

    async prepareImage(file, name, signal) {
      if (file.size > MAX_UPLOAD_BYTES) {
        const megabytes = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))
        throw new PlaygroundError('too_large', `${name} is larger than the ${megabytes} MB input limit.`)
      }
      const type = file.type || 'application/octet-stream'
      if (file.size <= INLINE_IMAGE_BYTES) {
        return toDataUrl(new Uint8Array(await file.arrayBuffer()), type)
      }
      const form = new FormData()
      form.append('content', file, name)
      form.append('filename', name)
      form.append('type', type)
      const body = await http.request('POST', '/v1/files', { body: form, signal })
      const urls = isRecord(body) && isRecord(body.urls) ? body.urls : null
      if (!urls || !isUri(urls.get)) throw new PlaygroundError('http', 'Replicate did not return a link for the uploaded image.')
      return urls.get
    },

    async start(model, input, signal) {
      const { owner, name } = splitSlug(model.slug)
      const ref = model.ref as ReplicateModelRef
      const headers = { 'Cancel-After': CANCEL_AFTER }
      const body = ref.isOfficial
        ? await http.request('POST', `${modelPath(owner, name)}/predictions`, { body: { input }, headers, signal })
        : await http.request('POST', '/v1/predictions', {
            body: { version: `${owner}/${name}:${ref.versionId}`, input },
            headers,
            signal,
          })
      return mapPrediction(body, token)
    },

    async poll(providerRunId, signal) {
      return mapPrediction(await http.request('GET', predictionPath(providerRunId), { signal }), token)
    },

    async cancel(providerRunId) {
      await http.request('POST', `${predictionPath(providerRunId)}/cancel`)
    },

    async download(output: ProviderOutput, signal) {
      const url = outputUrl(output.url)
      if (R2_OUTPUT_HOST.test(url.hostname)) {
        const proxied = r2ProxyPath(url)
        if (!proxied) throw new PlaygroundError('unsupported_output', 'The output link has an unexpected shape.')
        return downloadImage(proxied, { fetch: deps.fetch, signal })
      }
      return downloadImage(url.href, { fetch: deps.fetch, signal, fallbackUrl: deliveryFallback(url) })
    },
  }
}

export const replicateProvider: ProviderDefinition = {
  id: 'replicate',
  label: 'Replicate',
  tokenLabel: 'API token',
  tokenUrl: 'https://replicate.com/account/api-tokens',
  defaultBaseURL: '/replicate',
  quickModels: [
    'black-forest-labs/flux-schnell',
    'black-forest-labs/flux-kontext-pro',
    'black-forest-labs/flux-2-pro',
    'google/nano-banana',
    'google/nano-banana-pro',
    'bytedance/seedream-4.5',
    'google/imagen-4',
    'prunaai/z-image-turbo',
  ],
  slugPattern: SLUG_PATTERN,
  retentionMs: 55 * 60_000,
  create: createReplicate,
}
