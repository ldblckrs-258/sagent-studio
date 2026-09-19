import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { LoaderCircle } from 'lucide-react'

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <LoaderCircle
      size={size}
      strokeWidth={2}
      aria-hidden="true"
      className="motion-safe:animate-spin"
    />
  )
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  )
}

/**
 * Discoverable keyboard shortcuts. Product UI gets state-conveying motion only,
 * so the panel slides 8px rather than staging an entrance.
 */
export function Shortcuts() {
  const [open, setOpen] = useState(false)

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') setOpen(false)
  }

  return (
    <div className="relative" onKeyDown={onKeyDown}>
      <button
        type="button"
        onClick={() => {
          if (isEditable(document.activeElement)) return
          setOpen((prev) => !prev)
        }}
        aria-expanded={open}
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts"
        className="relative inline-flex size-9 items-center justify-center rounded-sm border border-transparent font-mono text-xs text-muted transition-colors duration-150 ease-out-quart after:absolute after:-inset-1 after:content-[''] hover:border-rule-strong hover:text-ink"
      >
        ?
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Keyboard shortcuts"
          className="absolute right-0 top-9 z-40 w-64 rounded-sm border border-rule-strong bg-surface p-4 shadow-[0_1px_2px_oklch(0.22_0.02_264/0.05),0_12px_28px_-8px_oklch(0.22_0.02_264/0.16)] motion-safe:animate-[panel-in_180ms_var(--ease-out-quint)]"
        >
          <p className="label-micro">Shortcuts</p>
          <dl className="mt-3 grid gap-2.5 text-xs">
            {[
              ['1 / 2 / 3', 'Switch section'],
              ['/', 'Focus search'],
              ['R', 'Reload records'],
              ['L', 'Lock vault'],
              ['?', 'Toggle this panel'],
            ].map(([keys, action]) => (
              <div key={keys} className="flex items-baseline justify-between gap-4">
                <dt className="font-mono text-ink">{keys}</dt>
                <dd className="text-muted">{action}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 border-t border-rule pt-3 text-xs text-faint">
            Shortcuts are ignored while typing in a field.
          </p>
        </div>
      ) : null}
    </div>
  )
}
