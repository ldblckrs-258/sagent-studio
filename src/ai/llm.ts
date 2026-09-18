import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { resolveProvider } from './providers'
import type { Settings } from '../vault/settings'

export { LLMConfigError } from './providers'

export function createLLM(
  settings: Settings,
  providerId: string,
  modelOverride?: string,
): LanguageModel {
  const provider = resolveProvider(settings.providers, providerId)
  const modelId = modelOverride?.trim() || provider.defaultModel
  const compatible = createOpenAICompatible({
    baseURL: provider.baseURL,
    name: provider.id,
    apiKey: provider.apiKey,
  })
  return compatible.chatModel(modelId)
}
