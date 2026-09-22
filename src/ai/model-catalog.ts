import { MAX_MODELS_PER_PROVIDER } from './providers'
import type { ModelCaps, ModelConfig, ProviderConfig } from '../vault/settings'
import { validateModelCaps } from '../vault/settings'

/** Raised when a provider's model list cannot be read. Never includes the API key. */
export class ModelDiscoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ModelDiscoveryError'
  }
}

const TIMEOUT_MS = 12_000

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function normalizeBase(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, '')
}

/**
 * Candidate endpoints for an OpenAI-compatible model listing. The path is appended
 * to the configured base URL. When the base URL omits the version segment, the
 * versioned path is retried once, which is the most common configuration mistake.
 */
export function candidateModelUrls(baseURL: string): string[] {
  const base = normalizeBase(baseURL)
  if (!isHttpUrl(base)) return []
  const root = `${base}/models`
  if (/\/v\d+$/i.test(base)) return [root]
  return [root, `${base}/v1/models`]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 'true' || value === 'yes') return true
  if (value === 0 || value === 'false' || value === 'no') return false
  return undefined
}

/** Nested objects that gateways use to group capability metadata. */
const CAPABILITY_SOURCES = ['caps', 'capabilities', 'features', 'limits'] as const
const VISION_KEYS = [
  'vision', 'imageInput', 'image_input', 'images', 'multimodal',
  'supportsVision', 'supports_vision',
] as const
const SEARCH_KEYS = ['search', 'webSearch', 'web_search', 'supportsSearch', 'supports_search'] as const
const REASONING_KEYS = ['reasoning', 'thinking', 'supportsReasoning', 'supports_reasoning'] as const
const EMBEDDING_KEYS = [
  'embedding', 'isEmbedding', 'is_embedding', 'supportsEmbedding', 'supports_embedding',
] as const
const CONTEXT_KEYS = [
  'contextWindow', 'context_window', 'contextLength', 'context_length',
  'contextSize', 'context_size', 'maxContextTokens', 'max_context_tokens',
  'maxInputTokens', 'max_input_tokens', 'inputTokens', 'input_tokens',
] as const
const OUTPUT_KEYS = [
  'maxOutput', 'max_output', 'maxOutputTokens', 'max_output_tokens',
  'maxTokens', 'max_tokens', 'outputTokens', 'output_tokens',
  'maxCompletionTokens', 'max_completion_tokens',
] as const

function pick(sources: readonly Record<string, unknown>[], keys: readonly string[]): unknown {
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key]
      if (value !== undefined && value !== null) return value
    }
  }
  return undefined
}

/**
 * The caps a listing may carry. Providers disagree wildly on naming, so a
 * nested group (`caps`, `capabilities`, `features`, `limits`), an
 * OpenRouter-style `architecture`/`top_provider`, and flat aliases are all
 * read. Modality strings (`architecture`, or top-level `input_modalities`)
 * stand in for an explicit vision flag, and `model_type: "embedding"` or an
 * `embeddings` endpoint marks an embedding model. `validateModelCaps` drops
 * anything malformed, keeping "unknown" distinct from a real `false`.
 */
function readCaps(record: Record<string, unknown>): ModelCaps | undefined {
  const sources: Record<string, unknown>[] = []
  for (const key of CAPABILITY_SOURCES) {
    if (isRecord(record[key])) sources.push(record[key] as Record<string, unknown>)
  }
  const architecture = isRecord(record.architecture) ? record.architecture : {}
  const topProvider = isRecord(record.top_provider) ? record.top_provider : {}
  sources.push(architecture, topProvider, record)

  const architectureModalities = [
    ...(Array.isArray(architecture.input_modalities) ? architecture.input_modalities : []),
    ...(Array.isArray(architecture.output_modalities) ? architecture.output_modalities : []),
  ]
  // Gateways also report `input_modalities`/`output_modalities` at the top level.
  const recordInputs = Array.isArray(record.input_modalities) ? record.input_modalities : []
  const recordOutputs = Array.isArray(record.output_modalities) ? record.output_modalities : []
  const modalities = [...architectureModalities, ...recordInputs, ...recordOutputs].map((entry) =>
    String(entry).toLowerCase(),
  )
  const modalityString =
    typeof architecture.modality === 'string' ? architecture.modality.toLowerCase() : ''
  const supported = Array.isArray(record.supported_parameters)
    ? record.supported_parameters.map((entry) => String(entry).toLowerCase())
    : []
  const endpoints = Array.isArray(record.endpoints)
    ? record.endpoints.map((entry) => String(entry).toLowerCase())
    : []
  const modelType =
    typeof record.model_type === 'string'
      ? record.model_type.toLowerCase()
      : typeof record.type === 'string'
        ? record.type.toLowerCase()
        : ''

  const visionByModality =
    modalities.length > 0 || modalityString !== ''
      ? modalities.includes('image') || modalityString.includes('image')
      : undefined
  const reasoningBySupport =
    supported.length > 0
      ? supported.includes('reasoning') || supported.includes('include_reasoning')
      : undefined
  const embeddingByEndpoint = endpoints.includes('embeddings')
  const embeddingByType = modelType === 'embedding'

  return validateModelCaps({
    vision: toBoolean(pick(sources, VISION_KEYS)) ?? visionByModality,
    search: toBoolean(pick(sources, SEARCH_KEYS)),
    reasoning: toBoolean(pick(sources, REASONING_KEYS)) ?? reasoningBySupport,
    embedding:
      toBoolean(pick(sources, EMBEDDING_KEYS)) ??
      (embeddingByType || embeddingByEndpoint ? true : undefined),
    contextWindow: toNumber(pick(sources, CONTEXT_KEYS)),
    maxOutput: toNumber(pick(sources, OUTPUT_KEYS)),
  })
}

function readModel(entry: unknown): ModelConfig | null {
  if (typeof entry === 'string') {
    const id = entry.trim()
    return id === '' ? null : { id }
  }
  if (!isRecord(entry)) return null
  // `id`/`model` are ids; `name` is a display label on gateways that carry one
  // (Ollama also uses `name` as the id, so it is only a fallback).
  const id = firstString(entry, ['id', 'model']) ?? firstString(entry, ['name', 'alias'])
  if (id === null) return null
  const model: ModelConfig = { id }
  const display = firstString(entry, ['name', 'alias'])
  if (display !== null && display !== id) model.name = display
  const caps = readCaps(entry)
  if (caps) model.caps = caps
  return model
}

/**
 * Reads models out of the shapes OpenAI-compatible servers actually return:
 * `{ data: [{ id }] }`, `{ models: [{ name }] }` (Ollama native), a bare array,
 * and gateway listings that add a `name` and a `caps` block.
 */
export function extractModels(payload: unknown): ModelConfig[] {
  let entries: unknown[] = []
  if (Array.isArray(payload)) {
    entries = payload
  } else if (isRecord(payload)) {
    for (const key of ['data', 'models']) {
      if (Array.isArray(payload[key])) {
        entries = payload[key] as unknown[]
        break
      }
    }
  }
  const byId = new Map<string, ModelConfig>()
  for (const entry of entries) {
    const model = readModel(entry)
    if (model === null || byId.has(model.id)) continue
    byId.set(model.id, model)
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** Backwards-compatible ids-only view of `extractModels`. */
export function extractModelIds(payload: unknown): string[] {
  return extractModels(payload).map((model) => model.id)
}

async function requestModels(url: string, provider: ProviderConfig, signal: AbortSignal) {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (provider.apiKey.trim()) headers.authorization = `Bearer ${provider.apiKey.trim()}`
  return fetch(url, { headers, signal })
}

function describeStatus(status: number): string {
  if (status === 401 || status === 403) {
    return 'The provider rejected the API key for this request.'
  }
  if (status === 404) return 'No model listing exists at this address.'
  if (status === 429) return 'The provider is rate limiting requests. Try again shortly.'
  if (status >= 500) return `The provider returned a server error (${status}).`
  return `The provider returned an unexpected status (${status}).`
}

/**
 * Fetches the model list for a provider. Reads both `id` and `name` shapes and
 * never surfaces the API key in a thrown message.
 */
export async function fetchModels(provider: ProviderConfig): Promise<ModelConfig[]> {
  const urls = candidateModelUrls(provider.baseURL)
  if (urls.length === 0) {
    throw new ModelDiscoveryError('A valid http(s) base URL is required before discovering models.')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    let lastError: ModelDiscoveryError | null = null
    for (const url of urls) {
      let response: Response
      try {
        response = await requestModels(url, provider, controller.signal)
      } catch (cause) {
        if (controller.signal.aborted) {
          throw new ModelDiscoveryError('The provider did not respond within 12 seconds.', {
            cause,
          })
        }
        throw new ModelDiscoveryError(
          'The provider could not be reached. Check the base URL and that the server allows browser requests.',
          { cause },
        )
      }

      if (!response.ok) {
        lastError = new ModelDiscoveryError(describeStatus(response.status))
        continue
      }

      let payload: unknown
      try {
        payload = await response.json()
      } catch (cause) {
        throw new ModelDiscoveryError(
          'The response was not JSON. This address may not be an OpenAI-compatible API.',
          { cause },
        )
      }

      const models = extractModels(payload)
      if (models.length === 0) {
        throw new ModelDiscoveryError(
          'The provider returned no models. Add model IDs manually below.',
        )
      }
      return models
    }

    throw lastError ?? new ModelDiscoveryError('No model listing could be read from this provider.')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Merges a discovery into the current selection without exceeding the cap.
 *
 * A model the user already has keeps its own name and caps — a hand-set caps
 * block is a deliberate decision, and a re-fetch must not overwrite it. A
 * discovered model fills only the gaps: a missing name, or a entry added by
 * hand that has no caps yet.
 */
export function mergeModels(
  current: readonly ModelConfig[],
  discovered: readonly ModelConfig[],
): { models: ModelConfig[]; added: number; truncated: number } {
  const byId = new Map(current.map((model) => [model.id, model]))
  let added = 0
  let truncated = 0
  for (const found of discovered) {
    const existing = byId.get(found.id)
    if (existing) {
      if (existing.caps === undefined || existing.name === undefined) {
        byId.set(found.id, {
          ...existing,
          ...(existing.name === undefined && found.name !== undefined
            ? { name: found.name }
            : {}),
          ...(existing.caps === undefined && found.caps !== undefined
            ? { caps: found.caps }
            : {}),
        })
      }
      continue
    }
    if (byId.size >= MAX_MODELS_PER_PROVIDER) {
      truncated += 1
      continue
    }
    byId.set(found.id, found)
    added += 1
  }
  return { models: [...byId.values()], added, truncated }
}
