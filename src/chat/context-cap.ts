import {
  DEFAULT_AUTO_COMPACT_RATIO,
  DEFAULT_MAX_CONTEXT_TOKENS,
} from '../vault/settings'
import type { Settings } from '../vault/settings'
import type { ThreadConfig } from './types'

export interface ResolvedContextCap {
  maxContextTokens: number
  autoCompactRatio: number
  autoCompactEnabled: boolean
}

const FALLBACK: ResolvedContextCap = {
  maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
  autoCompactRatio: DEFAULT_AUTO_COMPACT_RATIO,
  autoCompactEnabled: true,
}

/**
 * The cap this conversation runs under. Only the window is per-thread, because
 * threads can point at different models; the ratio and the on/off switch stay
 * global so the policy is one decision rather than one per conversation.
 */
export function resolveContextCap(
  settings: Settings | null,
  config?: Pick<ThreadConfig, 'maxContextTokens'>,
): ResolvedContextCap {
  const global = settings?.context ?? FALLBACK
  const override = config?.maxContextTokens
  return {
    maxContextTokens:
      override !== undefined && Number.isInteger(override) && override > 0
        ? override
        : global.maxContextTokens,
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
