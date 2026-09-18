import { useEffect, useState } from 'react'
import { ErrorBoundary } from './vault/ErrorBoundary'
import { RecoveryScreen } from './vault/RecoveryScreen'
import { UnlockScreen } from './vault/UnlockScreen'
import { hasVault, useVaultStore } from './vault/store'
import type { VaultPresence } from './vault/store'
import { useIdleLock } from './vault/use-idle-lock'
import { ProvidersPanel } from './settings/ProvidersPanel'
import { DataEgressNotice } from './settings/DataEgressNotice'

function UnlockedApp() {
  const settings = useVaultStore((s) => s.settings)
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
      <DataEgressNotice />
      <ProvidersPanel />
    </section>
  )
}

export default function App() {
  const [presence, setPresence] = useState<VaultPresence | null>(null)
  const status = useVaultStore((s) => s.status)

  useEffect(() => {
    let active = true
    hasVault()
      .then((result) => {
        if (active) setPresence(result)
      })
      .catch((cause: unknown) => {
        if (active) useVaultStore.setState({ status: 'recovering', error: String(cause) })
      })
    return () => {
      active = false
    }
  }, [])

  if (presence === null) {
    return <p className="mt-24 text-center text-sm">Loading…</p>
  }

  if (status === 'recovering' || presence === 'partial') {
    return (
      <ErrorBoundary>
        <RecoveryScreen />
      </ErrorBoundary>
    )
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
