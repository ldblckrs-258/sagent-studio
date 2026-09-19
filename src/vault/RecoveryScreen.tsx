import { useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { useVaultStore } from './store'
import { Button } from '../ui/primitives'

export function RecoveryScreen() {
  const error = useVaultStore((s) => s.error)
  const recover = useVaultStore((s) => s.recover)
  const [busy, setBusy] = useState(false)

  const onRecover = async () => {
    setBusy(true)
    try {
      await recover()
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-[100dvh] items-center px-6 py-16 sm:px-10">
      <section className="mx-auto w-full max-w-xl">
        <span
          aria-hidden="true"
          className="mb-8 inline-flex size-10 items-center justify-center rounded-sm border border-danger-rule bg-danger-soft text-danger"
        >
          <ShieldAlert size={18} strokeWidth={1.75} />
        </span>
        <h1 className="text-3xl">This vault cannot be opened</h1>
        <p className="mt-5 max-w-lg text-muted">
          The stored record is damaged or a write was interrupted. This is separate from a wrong
          password, which would simply be rejected.
        </p>

        {error ? (
          <p
            role="alert"
            className="mt-8 border-t border-rule pt-5 font-mono text-xs leading-relaxed text-danger"
          >
            {error}
          </p>
        ) : null}

        <div className="mt-8 border-t border-rule pt-8">
          <p className="label-micro">Only available action</p>
          <p className="mt-3 max-w-md text-sm text-muted">
            Erasing removes every stored setting, key and document index. Encrypted data cannot be
            repaired, so this cannot be undone.
          </p>
          <Button
            type="button"
            variant="danger"
            onClick={() => void onRecover()}
            disabled={busy}
            className="mt-6"
          >
            {busy ? 'Erasing' : 'Erase vault and start over'}
          </Button>
        </div>
      </section>
    </main>
  )
}
