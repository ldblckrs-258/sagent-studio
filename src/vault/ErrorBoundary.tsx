import { Component } from 'react'
import type { ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <section className="mx-auto mt-24 w-full max-w-md rounded-lg border border-[var(--border)] p-6 text-left">
          <h1 className="mb-2 text-2xl">Something went wrong</h1>
          <p className="mb-4 text-sm">The app hit an unrecoverable error. Reload to try again.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded bg-[var(--accent)] px-3 py-2 text-white"
          >
            Reload
          </button>
        </section>
      )
    }
    return this.props.children
  }
}
