import { TypeSafeClient } from '@typesafe-ai/sdk'
import type { Settings } from '../vault/settings'

export class TypeSafeConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TypeSafeConfigError'
  }
}

export interface TypeSafeOptions {
  /**
   * Timeout per attempt in milliseconds. The SDK default is 10s; document-heavy
   * judgments need more. There is no total retry budget, so this is per attempt.
   */
  timeoutMs?: number
}

export function createTypeSafe(settings: Settings, options?: TypeSafeOptions): TypeSafeClient {
  const apiKey = settings.typesafe.apiKey.trim()
  if (!apiKey) {
    throw new TypeSafeConfigError('A TypeSafe API key is required.')
  }
  const model = settings.typesafe.model.trim()
  // TypeSafe sends no CORS headers, so a direct browser call is blocked at the
  // preflight. Default to the same-origin `/typesafe` proxy the app ships for
  // dev and preview; an explicit base URL still wins, and a static host must
  // proxy `/typesafe` to `https://api.typesafe.ai`.
  const baseURL =
    settings.typesafe.baseURL?.trim() || (typeof window !== "undefined" ? "/typesafe" : undefined)
  return new TypeSafeClient({
    apiKey,
    ...(model ? { defaultModel: model } : {}),
    ...(baseURL ? { baseURL } : {}),
    logLevel: 'warn',
    dangerouslyAllowBrowser: true,
    ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
  })
}
