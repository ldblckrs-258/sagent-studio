import { TypeSafeClient } from '@typesafe-ai/sdk'
import type { Settings } from '../vault/settings'

export class TypeSafeConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TypeSafeConfigError'
  }
}

export function createTypeSafe(settings: Settings): TypeSafeClient {
  const apiKey = settings.typesafe.apiKey.trim()
  if (!apiKey) {
    throw new TypeSafeConfigError('A TypeSafe API key is required.')
  }
  const model = settings.typesafe.model.trim()
  const baseURL = settings.typesafe.baseURL?.trim()
  return new TypeSafeClient({
    apiKey,
    ...(model ? { defaultModel: model } : {}),
    ...(baseURL ? { baseURL } : {}),
    logLevel: 'warn',
    dangerouslyAllowBrowser: true,
  })
}
