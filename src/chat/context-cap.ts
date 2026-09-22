import { contextWindowFor } from '../ai/model-caps'
import {
  DEFAULT_AUTO_COMPACT_RATIO,
  DEFAULT_MAX_CONTEXT_TOKENS,
} from '../vault/settings'
import type { Settings } from '../vault/settings'

export interface ResolvedContextCap {
  maxContextTokens: number
  autoCompactRatio: number
  autoCompactEnabled: boolean
}

/** The selection the cap is resolved against; only the model identity is read. */
export type ContextCapConfig = {
  providerId?: string
  modelId?: string
  maxContextTokens?: number
}

const FALLBACK: ResolvedContextCap = {
  maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
  autoCompactRatio: DEFAULT_AUTO_COMPACT_RATIO,
  autoCompactEnabled: true,
}

/**
 * The cap this conversation runs under. The window prefers, in order: the
 * thread's explicit override, the active model's reported `contextWindow`, and
 * the global fallback. The ratio and the on/off switch stay global so the
 * policy is one decision rather than one per conversation.
 */
export function resolveContextCap(
  settings: Settings | null,
  config?: ContextCapConfig,
): ResolvedContextCap {
  const global = settings?.context ?? FALLBACK
  const override = config?.maxContextTokens
  const modelWindow = contextWindowFor(
    settings,
    config?.providerId,
    config?.modelId,
  )
  return {
    maxContextTokens:
      override !== undefined && Number.isInteger(override) && override > 0
        ? override
        : (modelWindow ?? global.maxContextTokens),
    autoCompactRatio: global.autoCompactRatio,
    autoCompactEnabled: global.autoCompactEnabled,
  }
}

/** The compaction threshold in tokens, which the meter also draws as a tick. */
export function autoCompactThreshold(cap: ResolvedContextCap): number {
  return cap.maxContextTokens * cap.autoCompactRatio
}

export function shouldAutoCompact(
  contextTokens: number,
  cap: ResolvedContextCap,
): boolean {
  if (!cap.autoCompactEnabled) return false
  return contextTokens >= autoCompactThreshold(cap)
}
