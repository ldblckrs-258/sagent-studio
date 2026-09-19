import { Server, X } from 'lucide-react'
import { useVaultStore } from '../vault/store'

export function DataEgressNotice() {
  const dismissed = useVaultStore((s) => s.settings?.egressNoticeDismissed ?? false)
  const update = useVaultStore((s) => s.update)

  if (dismissed) return null

  return (
    <aside
      role="note"
      className="rounded-sm border border-accent-rule bg-accent-soft px-2.5 py-2"
    >
      <div className="flex gap-2">
        <Server
          size={15}
          strokeWidth={1.75}
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-accent"
        />
        <div className="min-w-0">
          <h2 className="text-xs font-medium text-ink">What leaves this device</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Query text and matched document chunks are sent to TypeSafe and to whichever LLM
            provider you select. Keys, settings and the document index never leave.
          </p>
          <button
            type="button"
            onClick={() => void update({ egressNoticeDismissed: true }).catch(() => undefined)}
            className="relative mt-2 inline-flex min-h-7 items-center gap-1 rounded-sm border border-accent-rule px-2 text-xs text-ink transition-colors duration-150 ease-out-quart after:absolute after:-inset-1 after:content-[''] hover:bg-surface active:translate-y-px"
          >
            <X size={12} strokeWidth={2} aria-hidden="true" />
            Dismiss
          </button>
        </div>
      </div>
    </aside>
  )
}
