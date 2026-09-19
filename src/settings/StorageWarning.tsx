import { useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { useVaultStore } from '../vault/store'
import { Button } from '../ui/primitives'

export function StorageWarning() {
  const persistedStorage = useVaultStore((s) => s.persistedStorage)
  const request = useVaultStore((s) => s.requestPersistentStorage)
  const supported = typeof navigator !== 'undefined' && typeof navigator.storage?.persist === 'function'
  const [state, setState] = useState<'idle' | 'asking' | 'denied'>('idle')

  if (persistedStorage !== false) return null

  const onRequest = async () => {
    setState('asking')
    const granted = await request()
    setState(granted ? 'idle' : 'denied')
  }

  return (
    <aside
      role="alert"
      className="flex flex-col gap-2 rounded-sm border border-caution-rule bg-caution-soft px-2.5 py-2"
    >
      <div className="flex gap-2">
        <TriangleAlert
          size={15}
          strokeWidth={1.75}
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-caution"
        />
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink">Persistent storage is not granted</p>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            The browser may evict this vault under storage pressure, and an evicted vault cannot be
            decrypted. Granting persistence asks the browser to keep it until you clear site data.
          </p>
          {!supported ? (
            <p role="alert" className="mt-2 font-mono text-xs text-caution">
              This browser does not expose the persistent storage API.
            </p>
          ) : null}
          {state === 'denied' ? (
            <p role="alert" className="mt-2 font-mono text-xs text-caution">
              The browser declined the request. Chrome grants persistence automatically once the site
              is installed or often revisited; Firefox prompts on request.
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => void onRequest()}
              disabled={state === 'asking' || !supported}
            >
              {state === 'asking' ? 'Requesting' : 'Request persistent storage'}
            </Button>
            {supported ? (
              <span className="text-xs text-faint">Asked automatically each time you unlock.</span>
            ) : null}
          </div>
        </div>
      </div>
    </aside>
  )
}
