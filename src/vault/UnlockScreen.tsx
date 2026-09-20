import { useState } from 'react'
import type { FormEvent, InputHTMLAttributes } from 'react'
import { Eye, EyeOff, LockKeyhole } from 'lucide-react'
import { useVaultStore } from './store'
import { MIN_PASSWORD_LENGTH, scorePassword } from './password-strength'
import type { PasswordStrengthTone } from './password-strength'
import { Button, Field, IconButton, Input } from '../ui/primitives'
import { Spinner } from '../ui/shortcuts'

const CAPABILITIES = [
  {
    term: 'Agent loop',
    detail: 'Streaming threads, tool calls, and history that survives a reload.',
  },
  {
    term: 'Tools and skills',
    detail: 'Built-in file and code tools, HTTP tools, and per-conversation skills.',
  },
  {
    term: 'Runtimes',
    detail: 'JavaScript and Python run in isolated workers and report back to the thread.',
  },
  {
    term: 'Workspace',
    detail: 'Your own folder tree, editor and glob search, opened without a server.',
  },
] as const

const VAULT_SPEC =
  'AES-256-GCM with per-record AAD · PBKDF2-SHA256 at 600,000 iterations · IndexedDB, origin-scoped'

const METER_TONES: Record<PasswordStrengthTone, { fill: string; label: string }> = {
  danger: { fill: 'bg-danger', label: 'text-danger' },
  caution: { fill: 'bg-caution', label: 'text-caution' },
  positive: { fill: 'bg-positive', label: 'text-positive' },
}

const STRENGTH_SEGMENTS = [0, 1, 2, 3] as const

function Wordmark() {
  return (
    <span className="flex items-center gap-3">
      <span className="font-mono text-xs uppercase tracking-[0.08em] text-ink">Sagent Studio</span>
      <span aria-hidden="true" className="h-px w-6 bg-rule-strong" />
      <span className="label-micro">agentic harness</span>
    </span>
  )
}

function PasswordStrengthMeter({ password }: { password: string }) {
  if (!password) return null
  const strength = scorePassword(password)
  const tone = METER_TONES[strength.tone]
  return (
    <span className="flex items-center gap-3">
      <span aria-hidden="true" className="flex flex-1 gap-1">
        {STRENGTH_SEGMENTS.map((segment) => (
          <span
            key={segment}
            className={`h-0.5 flex-1 rounded-sm ${segment < strength.score ? tone.fill : 'bg-rule'}`}
          />
        ))}
      </span>
      <span className={`w-20 shrink-0 text-right font-mono text-xs ${tone.label}`}>
        {strength.label}
      </span>
    </span>
  )
}

function PasswordInput({
  visible,
  onToggleVisible,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> & {
  visible: boolean
  onToggleVisible(): void
}) {
  return (
    <span className="relative block">
      <Input {...rest} type={visible ? 'text' : 'password'} className="pr-10" />
      <span className="absolute inset-y-0 right-1 flex items-center">
        <IconButton label={visible ? 'Hide password' : 'Show password'} onClick={onToggleVisible}>
          {visible ? <EyeOff size={15} strokeWidth={1.75} /> : <Eye size={15} strokeWidth={1.75} />}
        </IconButton>
      </span>
    </span>
  )
}

interface ValidationError {
  field: 'password' | 'confirmation'
  message: string
}

export function UnlockScreen({ presence }: { presence: 'none' | 'complete' }) {
  const setup = useVaultStore((s) => s.setup)
  const unlock = useVaultStore((s) => s.unlock)
  const status = useVaultStore((s) => s.status)
  const error = useVaultStore((s) => s.error)
  const clearError = useVaultStore((s) => s.clearError)
  const firstRun = presence === 'none'
  const busy = status === 'unlocking'
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [validation, setValidation] = useState<ValidationError | null>(null)

  const toggleRevealed = () => setRevealed((value) => !value)

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (firstRun && password.length < MIN_PASSWORD_LENGTH) {
      setValidation({
        field: 'password',
        message: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
      })
      return
    }
    if (firstRun && confirmation !== password) {
      setValidation({ field: 'confirmation', message: 'The two entries do not match.' })
      return
    }
    setValidation(null)
    try {
      if (firstRun) {
        await setup(password)
      } else {
        await unlock(password)
      }
      setPassword('')
      setConfirmation('')
    } catch {
      // The store maps the rejection to a typed message shown below the field.
    }
  }

  return (
    <main className="grid min-h-[100dvh] lg:grid-cols-[1fr_minmax(0,40rem)]">
      <section className="order-2 hidden flex-col justify-between gap-10 border-r border-rule px-10 py-12 lg:order-1 lg:flex xl:px-16">
        <Wordmark />

        <div className="max-w-lg">
          <h1 className="text-3xl leading-[1.12] xl:text-4xl">
            The agent harness that runs on the machine in front of you.
          </h1>
          <p className="mt-6 max-w-md text-muted">
            Bring your own OpenAI-compatible provider, point a model at a workspace, and let it
            read files, call tools and run code. Keys, threads and documents stay local; only the
            requests you send leave this browser.
          </p>

          <dl className="mt-10">
            {CAPABILITIES.map((capability, index) => (
              <div
                key={capability.term}
                className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-4 border-t border-rule py-4"
              >
                <span aria-hidden="true" className="numeric pt-px font-mono text-xs text-faint">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div className="min-w-0">
                  <dt className="text-sm text-ink">{capability.term}</dt>
                  <dd className="mt-1 text-xs leading-relaxed text-muted">{capability.detail}</dd>
                </div>
              </div>
            ))}
          </dl>
        </div>

        <p className="font-mono text-xs leading-relaxed text-faint">{VAULT_SPEC}</p>
      </section>

      <section className="order-1 flex flex-col justify-center px-6 py-16 sm:px-10 lg:order-2 lg:py-20 xl:px-14">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <Wordmark />
          </div>
          <span
            aria-hidden="true"
            className="mb-8 inline-flex size-10 items-center justify-center rounded-sm border border-rule-strong text-accent"
          >
            <LockKeyhole size={18} strokeWidth={1.75} />
          </span>
          <h2 className="text-2xl">{firstRun ? 'Create your vault' : 'Unlock the vault'}</h2>
          <p className="mt-3 text-sm text-muted">
            {firstRun
              ? 'Choose a password. It derives the key for everything the studio keeps on this device: provider keys, conversations and workspace settings.'
              : 'Enter your password to derive the key and resume your conversations, workspace and provider keys.'}
          </p>

          <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-6">
            <Field
              label="Password"
              error={validation?.field === 'password' ? validation.message : (error ?? undefined)}
            >
              <PasswordInput
                name="password"
                autoComplete={firstRun ? 'new-password' : 'current-password'}
                autoFocus
                required
                minLength={MIN_PASSWORD_LENGTH}
                disabled={busy}
                visible={revealed}
                onToggleVisible={toggleRevealed}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value)
                  setValidation(null)
                  if (error) clearError()
                }}
              />
              {firstRun ? <PasswordStrengthMeter password={password} /> : null}
            </Field>

            {firstRun ? (
              <Field
                label="Confirm password"
                error={validation?.field === 'confirmation' ? validation.message : undefined}
              >
                <PasswordInput
                  name="confirmation"
                  autoComplete="new-password"
                  required
                  disabled={busy}
                  visible={revealed}
                  onToggleVisible={toggleRevealed}
                  value={confirmation}
                  onChange={(event) => {
                    setConfirmation(event.target.value)
                    setValidation(null)
                  }}
                />
              </Field>
            ) : null}

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
