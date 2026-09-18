import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './vault/ErrorBoundary'
import { useVaultStore } from './vault/store'

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  if (
    reason &&
    typeof reason === 'object' &&
    'name' in reason &&
    typeof (reason as { name: unknown }).name === 'string'
  ) {
    const name = (reason as { name: string }).name
    if (name === 'WrongPasswordError') return
    if (name.startsWith('Vault') || name === 'CorruptVaultError') {
      useVaultStore.setState({ error: (reason as Error).message, status: 'recovering' })
    }
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
