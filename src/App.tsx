import { useEffect } from 'react'
import { ErrorBoundary } from './vault/ErrorBoundary'
import { RecoveryScreen } from './vault/RecoveryScreen'
import { UnlockScreen } from './vault/UnlockScreen'
import { useVaultStore } from './vault/store'
import { useIdleLock } from './vault/use-idle-lock'
import { ProvidersPanel } from './settings/ProvidersPanel'
import { DataEgressNotice } from './settings/DataEgressNotice'

function UnlockedApp() {
  const settings = useVaultStore((s) => s.settings)
  const persistedStorage = useVaultStore((s) => s.persistedStorage)
  const lock = useVaultStore((s) => s.lock)

  useIdleLock(settings?.idleLockMinutes ?? 15, true, () => void lock())

  return (
    <section className="mx-auto mt-12 w-full max-w-2xl pb-24 text-left">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl">Sagent Studio</h1>
        <button
          type="button"
          onClick={() => void lock()}
          className="rounded border border-[var(--border)] px-3 py-1"
        >
          Lock
        </button>
      </header>
      {persistedStorage === false ? (
        <p role="alert" className="mb-4 rounded border border-[var(--accent-border)] p-3 text-xs">
          Persistent storage was denied. The browser may evict the vault under storage pressure,
          which would make it unrecoverable.
        </p>
      ) : null}
      <DataEgressNotice />
      <ProvidersPanel />
    </section>
  )
}

export default function App() {
  const presence = useVaultStore((s) => s.presence)
  const status = useVaultStore((s) => s.status)
  const refreshPresence = useVaultStore((s) => s.refreshPresence)

  useEffect(() => {
    void refreshPresence()
  }, [refreshPresence])

  if (status === 'recovering' || presence === 'partial') {
    return (
      <ErrorBoundary>
        <RecoveryScreen />
      </ErrorBoundary>
    )
  }

  if (presence === null) {
    return <p className="mt-24 text-center text-sm">Loading…</p>
  }

  if (status === 'unlocked') {
    return (
      <ErrorBoundary>
        <UnlockedApp />
      </ErrorBoundary>
    )
  }

  return (
    <ErrorBoundary>
      <UnlockScreen presence={presence} />
    </ErrorBoundary>
  )
}
