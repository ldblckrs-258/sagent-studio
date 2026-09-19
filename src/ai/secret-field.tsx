import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'

interface SecretFieldProps {
  name: string
  storedValue: string
  onChange: (value: string) => void
  placeholder?: string
}

const MASK = '••••••••••••'

export function SecretField({ name, storedValue, onChange, placeholder }: SecretFieldProps) {
  const [revealed, setRevealed] = useState(false)

  const hasStored = storedValue.length > 0
  const visibleValue = revealed ? storedValue : ''

  return (
    <div className="relative">
      <input
        name={name}
        type={revealed ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        readOnly={!revealed && hasStored}
        value={visibleValue}
        placeholder={hasStored && !revealed ? MASK : (placeholder ?? 'Paste your key')}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-8 w-full rounded-sm border border-rule-strong bg-surface py-1 pl-2 pr-10 font-mono text-sm transition-colors duration-150 ease-out-quart placeholder:tracking-widest placeholder:text-faint hover:border-muted focus:border-accent"
      />
      <button
        type="button"
        aria-pressed={revealed}
        aria-label={revealed ? 'Hide API key' : 'Reveal API key'}
        title={revealed ? 'Hide API key' : 'Reveal API key'}
        onClick={() => setRevealed((prev) => !prev)}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-faint transition-colors duration-150 ease-out-quart hover:text-ink"
      >
        {revealed ? (
          <EyeOff size={15} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <Eye size={15} strokeWidth={1.75} aria-hidden="true" />
        )}
      </button>
    </div>
  )
}
