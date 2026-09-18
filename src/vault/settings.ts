import { VaultMigrationError } from './errors'

export const SETTINGS_VERSION = 1

export interface ProviderConfig {
  id: string
  label: string
  kind: 'openai-compatible'
  baseURL: string
  apiKey: string
  models: string[]
  defaultModel: string
}

export interface TypeSafeSettings {
  apiKey: string
  model: string
  baseURL?: string
}

export interface RagSettings {
  embedModel: string
  chunkSize: number
  overlap: number
  topK: number
  thresholds: Record<string, number>
  concurrency: number
}

export interface Settings {
  version: number
  providers: ProviderConfig[]
  typesafe: TypeSafeSettings
  rag: RagSettings
  egressNoticeDismissed: boolean
  idleLockMinutes: number
}

export const MAX_PROVIDERS = 20
export const MAX_MODELS_PER_PROVIDER = 50

export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    providers: [],
    typesafe: { apiKey: '', model: 'jev-latest' },
    rag: {
      embedModel: 'text-embedding-3-small',
      chunkSize: 1000,
      overlap: 200,
      topK: 5,
      thresholds: {},
      concurrency: 2,
    },
    egressNoticeDismissed: false,
    idleLockMinutes: 15,
  }
}

type PlainObject = Record<string, unknown>

export type DeepPartial<T> = T extends object
  ? T extends readonly unknown[]
    ? T
    : { [K in keyof T]?: DeepPartial<T[K]> }
  : T

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) {
    return patch === undefined ? base : (patch as T)
  }
  if (!isPlainObject(base)) {
    return deepMerge({} as PlainObject, patch) as T
  }
  const out: PlainObject = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = out[key]
    out[key] = isPlainObject(value) && isPlainObject(current) ? deepMerge(current, value) : value
  }
  return out as T
}

export function migrate(version: number, data: unknown): Settings {
  if (!Number.isInteger(version) || version < 1) {
    throw new VaultMigrationError(`Invalid settings version: ${String(version)}`)
  }
  if (version > SETTINGS_VERSION) {
    throw new VaultMigrationError(
      `Settings version ${version} is newer than this app supports (${SETTINGS_VERSION}).`,
    )
  }
  return deepMerge(defaultSettings(), data)
}
