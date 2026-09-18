import { useVaultStore } from '../vault/store'

export function DataEgressNotice() {
  const dismissed = useVaultStore((s) => s.settings?.egressNoticeDismissed ?? false)
  const update = useVaultStore((s) => s.update)

  if (dismissed) return null

  return (
    <aside
      role="note"
      className="mb-6 rounded border border-[var(--accent-border)] bg-[var(--accent-bg)] p-4 text-left text-sm"
    >
      <p className="mb-2">
        Your query text and document chunks leave this device and are sent to TypeSafe and the
        LLM provider you select. They are not sent anywhere else.
      </p>
      <button
        type="button"
        onClick={() => void update({ egressNoticeDismissed: true })}
        className="rounded border border-[var(--border)] px-3 py-1 text-xs"
      >
        I understand
      </button>
    </aside>
  )
}
