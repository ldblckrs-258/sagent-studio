import { useState } from 'react'
import type { FormEvent } from 'react'
import { LockKeyhole } from 'lucide-react'
import { useVaultStore } from './store'
import { Button, Field, Input } from '../ui/primitives'
import { Spinner } from '../ui/shortcuts'

export function UnlockScreen({ presence }: { presence: 'none' | 'complete' }) {
  const setup = useVaultStore((s) => s.setup)
  const unlock = useVaultStore((s) => s.unlock)
  const status = useVaultStore((s) => s.status)
  const error = useVaultStore((s) => s.error)
  const firstRun = presence === 'none'
  const busy = status === 'unlocking'
  const [password, setPassword] = useState('')
  const [lengthError, setLengthError] = useState<string | null>(null)

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (firstRun && password.length < 8) {
      setLengthError('Use at least 8 characters.')
      return
    }
    setLengthError(null)
    try {
      if (firstRun) {
        await setup(password)
      } else {
        await unlock(password)
      }
      setPassword('')
    } catch {
      // The store maps the rejection to a typed message shown below the field.
    }
  }

  return (
    <main className="grid min-h-[100dvh] lg:grid-cols-[1fr_minmax(0,40rem)]">
      <section className="order-2 hidden flex-col justify-between border-r border-rule px-10 py-12 lg:order-1 lg:flex xl:px-16">
        <p className="label-micro">Sagent Studio / local vault</p>
        <div className="max-w-md">
          <h1 className="text-3xl leading-[1.12] xl:text-4xl">
            Your keys and documents stay on this machine.
          </h1>
          <p className="mt-6 max-w-sm text-muted">
            The vault encrypts provider keys, model settings and retrieval preferences in this
            browser. Nothing is uploaded until you configure a provider and run a query.
          </p>
        </div>
        <dl className="grid max-w-md gap-y-4">
          {[
            ['Cipher', 'AES-256-GCM with per-record AAD'],
            ['Key derivation', 'PBKDF2-SHA256, 600,000 iterations'],
            ['Storage', 'IndexedDB, origin-scoped'],
          ].map(([term, value]) => (
            <div key={term} className="grid gap-1 border-t border-rule pt-4 sm:grid-cols-[9rem_1fr]">
              <dt className="label-micro">{term}</dt>
              <dd className="font-mono text-xs leading-relaxed text-muted">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="order-1 flex flex-col justify-center px-6 py-16 sm:px-10 lg:order-2 lg:py-20 xl:px-14">
        <div className="mx-auto w-full max-w-sm">
          <span
            aria-hidden="true"
            className="mb-8 inline-flex size-10 items-center justify-center rounded-sm border border-rule-strong text-accent"
          >
            <LockKeyhole size={18} strokeWidth={1.75} />
          </span>
          <h2 className="text-2xl">{firstRun ? 'Create your vault' : 'Unlock the vault'}</h2>
          <p className="mt-3 text-sm text-muted">
            {firstRun
              ? 'Choose a password. It derives the key that encrypts everything stored here.'
              : 'Enter your password to derive the key and decrypt your settings.'}
          </p>

          <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-6">
            <Field label="Password" error={lengthError ?? error ?? undefined}>
              <Input
                name="password"
                type="password"
                autoComplete={firstRun ? 'new-password' : 'current-password'}
                autoFocus
                required
                minLength={8}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value)
                  if (lengthError) setLengthError(null)
                }}
              />
            </Field>
            <Button
              type="submit"
              variant="primary"
              disabled={busy}
              className="w-full"
              icon={busy ? <Spinner /> : undefined}
            >
              {busy ? 'Deriving key' : firstRun ? 'Create vault' : 'Unlock'}
            </Button>
          </form>

          <p className="mt-8 border-t border-rule pt-5 font-mono text-xs leading-relaxed text-faint">
            There is no recovery path. If you forget this password the vault cannot be decrypted,
            by design.
          </p>
        </div>
      </section>
    </main>
  )
}
