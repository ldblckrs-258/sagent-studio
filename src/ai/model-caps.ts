import type { ModelCaps, ModelConfig, Settings } from '../vault/settings'

/**
 * The model a request will use, resolved from the thread's selection with the
 * first provider and its default model as the fallback. Kept next to
 * `context-cap.ts`'s lookup so the window and the capability gate can never
 * disagree about which model is active.
 */
export function activeModel(
  settings: Settings | null,
  providerId: string | undefined,
  modelId: string | undefined,
): ModelConfig | undefined {
  if (settings === null) return undefined
  const provider =
    settings.providers.find((candidate) => candidate.id === providerId) ??
    settings.providers[0]
  if (!provider) return undefined
  const wanted = modelId?.trim() || provider.defaultModel
  return (
    provider.models.find((model) => model.id === wanted) ??
    provider.models.find((model) => model.id === provider.defaultModel)
  )
}

export function activeModelCaps(
  settings: Settings | null,
  providerId: string | undefined,
  modelId: string | undefined,
): ModelCaps | undefined {
  return activeModel(settings, providerId, modelId)?.caps
}

/**
 * Caps for the exact listed model, with no fallback to another model. The
 * embedding model is addressed by id and is not necessarily the provider's
 * default, so a caller that must respect *that* model's window cannot reuse
 * `activeModelCaps`'s fallback.
 */
export function modelCapsFor(
  settings: Settings | null,
  providerId: string | undefined,
  modelId: string | undefined,
): ModelCaps | undefined {
  if (settings === null) return undefined
  const wanted = modelId?.trim()
  if (!wanted) return undefined
  const provider =
    settings.providers.find((candidate) => candidate.id === providerId) ??
    settings.providers[0]
  return provider?.models.find((model) => model.id === wanted)?.caps
}

/**
 * The model's window when it reports one, otherwise undefined so the caller can
 * fall back to the user's global cap.
 */
export function contextWindowFor(
  settings: Settings | null,
  providerId: string | undefined,
  modelId: string | undefined,
): number | undefined {
  const window = activeModelCaps(settings, providerId, modelId)?.contextWindow
  return typeof window === 'number' && Number.isInteger(window) && window > 0
    ? window
    : undefined
}

/**
 * Whether the active model accepts image parts. Unknown caps assume vision,
 * because gating a model that can actually see images is worse than sending one
 * an image it ignores; the user can turn vision off per model to be stricter.
 */
export function modelSupportsVision(
  settings: Settings | null,
  providerId: string | undefined,
  modelId: string | undefined,
): boolean {
  return activeModelCaps(settings, providerId, modelId)?.vision ?? true
}
