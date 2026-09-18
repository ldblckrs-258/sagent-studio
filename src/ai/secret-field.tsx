import { useState } from 'react'

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
    <div className="flex items-center gap-2">
      <input
        name={name}
        type={revealed ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        readOnly={!revealed && hasStored}
        value={visibleValue}
        placeholder={hasStored && !revealed ? MASK : (placeholder ?? 'Paste your key')}
        onChange={(event) => onChange(event.target.value)}
        className="flex-1 rounded border border-[var(--border)] bg-transparent px-3 py-2 font-mono text-sm"
      />
      <button
        type="button"
        aria-pressed={revealed}
        onClick={() => setRevealed((prev) => !prev)}
        className="rounded border border-[var(--border)] px-3 py-2 text-xs"
      >
        {revealed ? 'Hide' : 'Reveal'}
      </button>
    </div>
  )
}
