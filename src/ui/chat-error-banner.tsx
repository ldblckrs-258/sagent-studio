import { useChatStore } from '../chat/store'

/**
 * App-owned error surface, rendered immediately above the composer. Errors are
 * never projected into message status; the engine redacts text before storing.
 */
export function ChatErrorBanner() {
  const error = useChatStore((s) => s.error)
  if (!error) return null
  return (
    <div
      role="alert"
      className="rounded-sm border border-danger-rule bg-danger-soft px-3 py-2 font-mono text-xs text-danger"
    >
      {error}
    </div>
  )
}
