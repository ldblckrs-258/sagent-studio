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

/**
 * Structural mirror of the chat layer's `SkillRef`, declared locally so the
 * vault layer imports nothing from `src/chat`.
 */
export interface PersistedSkillRef {
  id: string
  source: 'vault' | 'workspace'
}

export interface SandboxSettings {
  enabled: boolean
  jsTimeoutMs: number
  pyTimeoutMs: number
  idleTimeoutMs: number
}

/**
 * The context window the chat measures itself against. It is user-supplied
 * because `model-catalog.ts` discovers model ids from OpenAI-compatible
 * endpoints and those endpoints report no context-window metadata, so there is
 * nothing to infer the cap from.
 */
export interface ContextSettings {
  maxContextTokens: number
  autoCompactRatio: number
  autoCompactEnabled: boolean
}

export const DEFAULT_MAX_CONTEXT_TOKENS = 128_000
export const DEFAULT_AUTO_COMPACT_RATIO = 0.8
export const MIN_AUTO_COMPACT_RATIO = 0.1
export const MAX_AUTO_COMPACT_RATIO = 0.95

export type ApprovalDecision = 'allow' | 'ask' | 'deny'

export interface ApprovalSettings {
  tools: Record<string, ApprovalDecision>
}

export const DEFAULT_APPROVAL_DECISION: ApprovalDecision = 'ask'

// Kept in sync with the runner constants by a unit test, without importing
// app-local sandbox modules into the vault layer.
export const DEFAULT_SANDBOX_JS_TIMEOUT_MS = 10_000
export const DEFAULT_SANDBOX_PY_TIMEOUT_MS = 30_000
export const DEFAULT_SANDBOX_IDLE_TIMEOUT_MS = 300_000

export interface Settings {
  version: number
  providers: ProviderConfig[]
  typesafe: TypeSafeSettings
  rag: RagSettings
  sandbox: SandboxSettings
  approvals: ApprovalSettings
  context: ContextSettings
  egressNoticeDismissed: boolean
  idleLockMinutes: number
  /**
   * Optional and deliberately absent by default: an absent policy means
   * "enable every vault skill", so existing vaults keep working. Adding it to
   * `defaultSettings()` would stamp an empty policy and disable every skill.
   */
  skills?: { enabled?: PersistedSkillRef[] }
}

export const MAX_PROVIDERS = 20
export const MAX_MODELS_PER_PROVIDER = 50

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

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
    sandbox: {
      enabled: true,
      jsTimeoutMs: DEFAULT_SANDBOX_JS_TIMEOUT_MS,
      pyTimeoutMs: DEFAULT_SANDBOX_PY_TIMEOUT_MS,
      idleTimeoutMs: DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
    },
    approvals: { tools: {} },
    context: {
      maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
      autoCompactRatio: DEFAULT_AUTO_COMPACT_RATIO,
      autoCompactEnabled: true,
    },
    egressNoticeDismissed: false,
    idleLockMinutes: 15,
  }
}

/**
 * Checks a context block and reports the first problem in the message. Throwing
 * is what `migrate` catches to fall back to the defaults, so a vault written by
 * hand stays loadable while a bad value never reaches the cap arithmetic.
 */
export function validateContextSettings(value: unknown): ContextSettings {
  if (!isPlainObject(value)) {
    throw new VaultMigrationError('The context settings must be an object.')
  }
  const maxContextTokens = value.maxContextTokens
  if (
    typeof maxContextTokens !== 'number' ||
    !Number.isInteger(maxContextTokens) ||
    maxContextTokens <= 0
  ) {
    throw new VaultMigrationError('maxContextTokens must be a positive integer.')
  }
  const autoCompactRatio = value.autoCompactRatio
  if (
    typeof autoCompactRatio !== 'number' ||
    !Number.isFinite(autoCompactRatio) ||
    autoCompactRatio < MIN_AUTO_COMPACT_RATIO ||
    autoCompactRatio > MAX_AUTO_COMPACT_RATIO
  ) {
    throw new VaultMigrationError(
      `autoCompactRatio must be between ${MIN_AUTO_COMPACT_RATIO} and ${MAX_AUTO_COMPACT_RATIO}.`,
    )
  }
  const autoCompactEnabled = value.autoCompactEnabled
  if (typeof autoCompactEnabled !== 'boolean') {
    throw new VaultMigrationError('autoCompactEnabled must be a boolean.')
  }
  return { maxContextTokens, autoCompactRatio, autoCompactEnabled }
}

type PlainObject = Record<string, unknown>

export type DeepPartial<T> = T extends object
  ? T extends readonly unknown[]
    ? T
    : { [K in keyof T]?: DeepPartial<T[K]> }
  : T

function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
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
    if (FORBIDDEN_KEYS.has(key)) continue
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
  if (!isPlainObject(data)) {
    throw new VaultMigrationError('Decrypted settings were not an object.')
  }
  const merged = deepMerge(defaultSettings(), data)
  // A vault written before the context block existed merges the defaults in;
  // one carrying an out-of-range value is repaired rather than made unloadable,
  // because the cap is a preference and refusing to unlock over it would lock
  // the user out of their own keys.
  try {
    return { ...merged, context: validateContextSettings(merged.context) }
  } catch {
    return { ...merged, context: defaultSettings().context }
  }
}
