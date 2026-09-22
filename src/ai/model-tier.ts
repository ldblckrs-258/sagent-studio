import type { LanguageModel } from 'ai'
import type { ChatMode } from '../chat/types'
import { createLLM } from './llm'
import type { ModelTier, Settings } from '../vault/settings'

/**
 * A tier selection resolved against the configured providers. A selection whose
 * provider no longer exists is treated as "not configured" rather than throwing,
 * because the tasks that use it are best-effort.
 */
export interface ResolvedTierModel {
  providerId: string
  modelId?: string
}

export type ModelFactory = (
  settings: Settings,
  providerId: string,
  modelId?: string,
) => LanguageModel

/**
 * The user-facing name and purpose of each tier. Labels live in the ai layer so
 * the vault layer stays free of presentation strings.
 */
export interface ModelTierMeta {
  label: string
  blurb: string
}

export const MODEL_TIER_META: Record<ModelTier, ModelTierMeta> = {
  cheap: {
    label: 'Spark',
    blurb: 'Fastest and cheapest. Names conversations and rewrites document queries.',
  },
  medium: {
    label: 'Forge',
    blurb: 'Balanced. The default tier for delegated agents in editing mode.',
  },
  high: {
    label: 'Prime',
    blurb: 'The strongest everyday tier. Used by delegated agents in god mode.',
  },
  max: {
    label: 'Oracle',
    blurb: 'Reserved for explicit advisory and planning delegations.',
  },
}

/**
 * The tier a delegated agent uses when the model did not name one. Read-only
 * work is cheap, editing work is medium, and unrestricted work is high; `max` is
 * never chosen implicitly.
 */
export function tierForMode(mode: ChatMode): ModelTier {
  if (mode === 'read_only') return 'cheap'
  if (mode === 'god') return 'high'
  return 'medium'
}

export function resolveTierModel(settings: Settings, tier: ModelTier): ResolvedTierModel | null {
  const selection = settings.modelTiers?.[tier]
  const providerId = selection?.providerId
  if (!providerId) return null
  if (!settings.providers.some((provider) => provider.id === providerId)) return null
  const modelId = selection?.modelId?.trim()
  return { providerId, ...(modelId ? { modelId } : {}) }
}

/**
 * Builds the tier's model, or null when the tier is unconfigured or its provider
 * fails validation. Never throws into a background task; the caller falls back
 * to the conversation's own model.
 */
export function createTierModel(
  settings: Settings,
  tier: ModelTier,
  factory: ModelFactory = createLLM,
): LanguageModel | null {
  const resolved = resolveTierModel(settings, tier)
  if (!resolved) return null
  try {
    return factory(settings, resolved.providerId, resolved.modelId)
  } catch {
    return null
  }
}
