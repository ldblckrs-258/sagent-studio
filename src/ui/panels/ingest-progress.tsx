import { FileSearch, Layers, Lock, Sparkles } from 'lucide-react'
import type { IngestPhase, IngestProgress } from '../../rag/types'

interface PhaseMeta {
  label: string
  detail: string
  Icon: typeof FileSearch
}

const PHASES: Record<IngestPhase, PhaseMeta> = {
  extracting: { label: 'Extracting text', detail: 'Reading the file', Icon: FileSearch },
  chunking: { label: 'Chunking', detail: 'Splitting into passages', Icon: Layers },
  embedding: { label: 'Embedding', detail: 'Sending passages to the model', Icon: Sparkles },
  persisting: { label: 'Encrypting and saving', detail: 'Writing to the vault', Icon: Lock },
}

const FALLBACK: PhaseMeta = { label: 'Working', detail: 'In progress', Icon: Layers }

/**
 * The live ingest state: which phase is running, how far along it is, and a bar
 * that fills as each embedding request and each encryption batch completes.
 * Phases with no measurable total (extract/chunk are single steps) render an
 * indeterminate sweep instead of a frozen `0/1`.
 */
export function IngestProgressRow({ progress }: { progress: IngestProgress }) {
  const phase = PHASES[progress.phase] ?? FALLBACK
  const { Icon } = phase
  const total = Math.max(0, progress.total)
  const done = Math.min(Math.max(0, progress.done), total)
  const determinate = total > 1
  const percent = determinate ? Math.round((done / total) * 100) : 0

  return (
    <div
      data-slot="aui_ingest-progress"
      role="status"
      aria-live="polite"
      className="animate-in fade-in flex items-start gap-2.5 rounded-sm border border-rule bg-surface px-3 py-2.5"
    >
      <span className="mt-px flex size-6 shrink-0 items-center justify-center rounded-sm bg-accent-soft text-accent">
        <Icon size={13} strokeWidth={1.75} aria-hidden="true" className="motion-safe:animate-pulse" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-xs font-medium text-ink">{phase.label}</span>
          {determinate ? (
            <span className="numeric shrink-0 font-mono text-xs text-muted">
              {done}
              <span className="text-faint">/{total}</span>
            </span>
          ) : (
            <span className="shimmer shrink-0 truncate text-xs text-faint motion-reduce:animate-none">
              {phase.detail}
            </span>
          )}
        </div>

        <div
          role="progressbar"
          aria-label={phase.label}
          aria-valuemin={0}
          aria-valuemax={determinate ? total : undefined}
          aria-valuenow={determinate ? done : undefined}
          className="relative mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-paper-sunk ring-1 ring-rule/70 ring-inset"
        >
          {determinate ? (
            <div
              className="relative h-full overflow-hidden rounded-full bg-accent transition-[width] duration-500 ease-out-quart"
              style={{ width: `${percent}%` }}
            >
              <span className="pointer-events-none absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-paper/60 to-transparent motion-safe:animate-[ingest-sheen_1.6s_ease-in-out_infinite]" />
            </div>
          ) : (
            <span className="block h-full w-1/3 rounded-full bg-accent/80 motion-safe:animate-[ingest-sweep_1.2s_ease-in-out_infinite]" />
          )}
        </div>
      </div>
    </div>
  )
}
