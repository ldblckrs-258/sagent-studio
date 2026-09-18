import { useVaultStore } from './store'

export function RecoveryScreen() {
  const error = useVaultStore((s) => s.error)
  const recover = useVaultStore((s) => s.recover)

  return (
    <section className="mx-auto mt-24 w-full max-w-md rounded-lg border border-[var(--border)] p-6 text-left">
      <h1 className="mb-2 text-2xl">Vault needs recovery</h1>
      <p className="mb-4 text-sm">
        The vault could not be opened. This happens when a write was interrupted or the stored
        data is damaged. It is not a wrong password.
      </p>
      {error ? <p role="alert" className="mb-4 rounded bg-[var(--accent-bg)] p-2 text-xs">{error}</p> : null}
      <p className="mb-4 rounded bg-[var(--accent-bg)] p-2 text-xs">
        Erasing removes all stored settings and secrets. This cannot be undone.
      </p>
      <button
        type="button"
        onClick={() => void recover()}
        className="rounded bg-[var(--accent)] px-3 py-2 text-white"
      >
        Erase vault and start over
      </button>
    </section>
  )
}
