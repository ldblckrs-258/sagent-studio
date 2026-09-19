import { useEffect } from 'react'
import { SessionProvider } from './session/session-provider'
import { Shell } from './ui/shell'
import { ErrorBoundary } from './vault/ErrorBoundary'
import { RecoveryScreen } from './vault/RecoveryScreen'
import { UnlockScreen } from './vault/UnlockScreen'
import { useVaultStore } from './vault/store'
import { useIdleLock } from './vault/use-idle-lock'
import { Spinner } from './ui/shortcuts'

function UnlockedApp() {
  const settings = useVaultStore((s) => s.settings)
  const lock = useVaultStore((s) => s.lock)

  useIdleLock(settings?.idleLockMinutes ?? 15, true, () => void lock())

  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
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
    return (
      <p className="flex min-h-[100dvh] items-center justify-center gap-3 font-mono text-xs text-faint">
        <Spinner />
        Opening local vault
      </p>
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
