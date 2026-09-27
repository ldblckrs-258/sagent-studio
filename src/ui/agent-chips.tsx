/*
  The chip visuals and the tier/mode metadata they read are one unit: splitting
  them across modules would let the two drift. Fast refresh therefore sees a
  mixed module, which this shared-vocabulary file accepts.
*/
/* eslint-disable react-refresh/only-export-components */
import type { ChatMode } from '../chat/types'
import { MODEL_TIER_META, tierForMode } from '../ai/model-tier'
import type { ModelTier } from '../vault/settings'
import { cn } from '../lib/utils'
import { ToolChip, type ChipTone } from '../components/assistant-ui/elements/tool-view/primitives'

export const TIERS: readonly ModelTier[] = ['cheap', 'medium', 'high', 'max']
export const MODES: readonly ChatMode[] = ['read_only', 'editing', 'god']

/**
 * One hue per tier, drawn from the workspace file-kind ramp so four choices read
 * as a single family. Oracle lands on the brand accent because it is the tier a
 * user reserves for deliberate advisory work.
 *
 * The three file hues are mixed 80% toward ink for the label: at their raw
 * lightness they sit at ~3.4:1 on paper, under the 4.5:1 floor for text. The
 * mix keeps the hue while clearing it, and because it is built from the theme
 * variables it follows both light and dark mode.
 */
export const TIER_CHIP: Record<ModelTier, string> = {
  cheap: 'border-file-data/40 bg-file-data/10 text-tier-spark',
  medium: 'border-file-code/40 bg-file-code/10 text-tier-forge',
  high: 'border-file-media/40 bg-file-media/10 text-tier-prime',
  max: 'border-accent-rule bg-accent-soft text-accent',
}

/** A mode's restraint reads as its color: safe is calm, unrestricted is danger. */
export const MODE_CHIP: Record<ChatMode, { tone: ChipTone; label: string }> = {
  read_only: { tone: 'positive', label: 'Read only' },
  editing: { tone: 'caution', label: 'Editing' },
  god: { tone: 'danger', label: 'God' },
}

export function asMode(value: unknown): ChatMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value)
    ? (value as ChatMode)
    : 'read_only'
}

export function asTier(value: unknown): ModelTier {
  if (typeof value === 'string' && (TIERS as readonly string[]).includes(value)) {
    return value as ModelTier
  }
  return tierForMode(asMode(value))
}

export function readMode(args: Record<string, unknown>): ChatMode {
  return asMode(args.mode)
}

export function readTier(args: Record<string, unknown>): ModelTier {
  return asTier(args.tier)
}

export function TierChip({ tier }: { tier: ModelTier }) {
  return (
    <span
      data-slot="agent-tier-chip"
      title={`${MODEL_TIER_META[tier].label} tier`}
      className={cn(
        'inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[10px] leading-none',
        TIER_CHIP[tier],
      )}
    >
      {MODEL_TIER_META[tier].label}
    </span>
  )
}

export function ModeChip({ mode }: { mode: ChatMode }) {
  const spec = MODE_CHIP[mode]
  return <ToolChip tone={spec.tone}>{spec.label}</ToolChip>
}

export function ProfileChip({ profile }: { profile: string }) {
  return (
    <span data-slot="agent-profile-chip" title={`Agent profile ${profile}`}>
      <ToolChip tone="accent">{profile}</ToolChip>
    </span>
  )
}
