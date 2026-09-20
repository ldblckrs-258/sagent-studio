import type { ReactNode } from 'react'

export function ViewerLoading({ label = 'Loading…' }: { label?: string }) {
  return <p className="p-3 font-mono text-xs text-faint">{label}</p>
}

export function ViewerError({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="m-2 border border-danger-rule bg-danger-soft px-2 py-1 font-mono text-xs text-danger"
    >
      {message}
    </p>
  )
}

export function ViewerNotice({ children }: { children: ReactNode }) {
  return <p className="p-3 font-mono text-xs text-faint">{children}</p>
}
