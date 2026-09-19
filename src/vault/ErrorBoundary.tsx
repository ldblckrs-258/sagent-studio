import { Component } from 'react'
import type { ReactNode } from 'react'
import { Button } from '../ui/primitives'

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
        <main className="flex min-h-[100dvh] items-center px-6 py-16 sm:px-10">
          <section className="mx-auto w-full max-w-xl">
            <p className="label-micro">Unhandled error</p>
            <h1 className="mt-4 text-3xl">The interface stopped responding</h1>
            <p className="mt-5 max-w-lg text-muted">
              Reloading rebuilds the interface from the encrypted record. Your vault is untouched,
              so you will need your password again.
            </p>
            <pre className="mt-8 overflow-x-auto border-t border-rule pt-5 font-mono text-xs leading-relaxed text-danger">
              {this.state.error.message}
            </pre>
            <Button
              type="button"
              variant="primary"
              onClick={() => window.location.reload()}
              className="mt-6"
            >
              Reload
            </Button>
          </section>
        </main>
      )
    }
    return this.props.children
  }
}
