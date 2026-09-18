import type { ProviderConfig } from '../vault/settings'
import { MAX_MODELS_PER_PROVIDER } from '../vault/settings'

export { MAX_MODELS_PER_PROVIDER, MAX_PROVIDERS } from '../vault/settings'

export class LLMConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LLMConfigError'
  }
}

export type ProviderField = 'id' | 'label' | 'baseURL' | 'apiKey' | 'models' | 'defaultModel'

export type ProviderValidationErrors = Partial<Record<ProviderField, string>>

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function validateProvider(provider: ProviderConfig): ProviderValidationErrors {
  const errors: ProviderValidationErrors = {}
  if (!provider.id.trim()) errors.id = 'A provider id is required.'
  if (!provider.label.trim()) errors.label = 'A label is required.'
  if (!isHttpUrl(provider.baseURL)) errors.baseURL = 'A valid http(s) base URL is required.'
  if (!provider.apiKey.trim()) errors.apiKey = 'An API key is required.'
  if (provider.models.length > MAX_MODELS_PER_PROVIDER) {
    errors.models = `A provider may list at most ${MAX_MODELS_PER_PROVIDER} models.`
  }
  if (provider.models.some((model) => !model.trim())) {
    errors.models = 'Model names cannot be blank.'
  }
  if (!provider.defaultModel.trim() || !provider.models.includes(provider.defaultModel)) {
    errors.defaultModel = 'The default model must be one of the listed models.'
  }
  return errors
}

export function isValidProvider(provider: ProviderConfig): boolean {
  return Object.keys(validateProvider(provider)).length === 0
}

export function resolveProvider(
  providers: readonly ProviderConfig[],
  providerId: string,
): ProviderConfig {
  const provider = providers.find((candidate) => candidate.id === providerId)
  if (!provider) {
    throw new LLMConfigError(`No provider is configured with id "${providerId}".`)
  }
  const errors = validateProvider(provider)
  if (Object.keys(errors).length > 0) {
    const summary = Object.entries(errors)
      .map(([field, message]) => `${field}: ${message}`)
      .join(' ')
    throw new LLMConfigError(`Provider "${providerId}" is invalid. ${summary}`)
  }
  return provider
}
