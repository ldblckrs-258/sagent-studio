import type { PlaygroundProvider, ProviderDefinition, ProviderDeps } from './provider'
import { replicateProvider } from './providers/replicate'
import type { PlaygroundProviderId } from './types'
import type { PlaygroundProvidersSettings } from '../vault/settings'

export const PROVIDERS: Record<PlaygroundProviderId, ProviderDefinition> = {
  replicate: replicateProvider,
}

export function listProviders(): ProviderDefinition[] {
  return Object.values(PROVIDERS)
}

export function providerFor(
  id: PlaygroundProviderId,
  settings: PlaygroundProvidersSettings | undefined,
  deps?: ProviderDeps,
): PlaygroundProvider | null {
  const config = settings?.[id]
  const definition = PROVIDERS[id]
  if (!config || config.apiKey.trim() === '' || !definition) return null
  return definition.create({ apiKey: config.apiKey, baseURL: config.baseURL || definition.defaultBaseURL }, deps)
}
