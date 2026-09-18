import type { FormEvent } from 'react'
import { useVaultStore } from './store'

export function UnlockScreen({ presence }: { presence: 'none' | 'complete' }) {
  const setup = useVaultStore((s) => s.setup)
  const unlock = useVaultStore((s) => s.unlock)
  const status = useVaultStore((s) => s.status)
  const error = useVaultStore((s) => s.error)
  const firstRun = presence === 'none'
  const busy = status === 'unlocking'

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const password = (form.elements.namedItem('password') as HTMLInputElement).value
    try {
      if (firstRun) {
        await setup(password)
      } else {
        await unlock(password)
      }
      form.reset()
    } catch {
      // Store maps the rejection to a typed message; nothing to add here.
    }
  }

  return (
    <section className="mx-auto mt-24 w-full max-w-sm rounded-lg border border-[var(--border)] p-6 text-left">
      <h1 className="mb-2 text-2xl">{firstRun ? 'Create your vault' : 'Unlock'}</h1>
      <p className="mb-4 text-sm">
        {firstRun
          ? 'Choose a password. It encrypts your settings and secrets locally.'
          : 'Enter your password to decrypt your local settings.'}
      </p>
      <p className="mb-4 rounded bg-[var(--accent-bg)] p-2 text-xs">
        This password cannot be recovered. If you forget it, the vault is unrecoverable.
      </p>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <input
          name="password"
          type="password"
          autoComplete={firstRun ? 'new-password' : 'current-password'}
          required
          minLength={8}
          placeholder="Password"
          className="rounded border border-[var(--border)] bg-transparent px-3 py-2"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-[var(--accent)] px-3 py-2 text-white disabled:opacity-50"
        >
          {busy ? 'Working…' : firstRun ? 'Create vault' : 'Unlock'}
        </button>
      </form>
      {error ? <p role="alert" className="mt-3 text-sm text-red-500">{error}</p> : null}
    </section>
  )
}
