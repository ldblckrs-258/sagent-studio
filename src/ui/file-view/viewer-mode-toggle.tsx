/** Preview/Source switch shared by the text-backed viewers. */
export function ViewerModeToggle({
  mode,
  onChange,
}: {
  mode: 'preview' | 'source'
  onChange(mode: 'preview' | 'source'): void
}) {
  const base = 'px-2 py-1 font-mono text-xs transition-colors'
  return (
    <div className="flex overflow-hidden rounded-sm border border-rule">
      <button
        type="button"
        aria-pressed={mode === 'preview'}
        onClick={() => onChange('preview')}
        className={`${base} ${mode === 'preview' ? 'bg-accent-soft text-accent' : 'text-muted hover:text-ink'}`}
      >
        Preview
      </button>
      <button
        type="button"
        aria-pressed={mode === 'source'}
        onClick={() => onChange('source')}
        className={`${base} border-l border-rule ${mode === 'source' ? 'bg-accent-soft text-accent' : 'text-muted hover:text-ink'}`}
      >
        Source
      </button>
    </div>
  )
}
