import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/archivo'
import '@fontsource-variable/jetbrains-mono'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './vault/ErrorBoundary'
import { useVaultStore } from './vault/store'

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  if (!reason || typeof reason !== 'object' || !('name' in reason)) return
  const name = (reason as { name: unknown }).name
  if (typeof name !== 'string') return

  // Benign, expected outcomes: a wrong password is reported inline by the unlock
  // form, and a locked write is a lost race, not a corrupt vault. Neither may
  // promote the UI to the erase-only recovery screen.
  if (name === 'WrongPasswordError' || name === 'VaultLockedError') return

  const error = reason instanceof Error ? reason.message : 'An unknown vault error occurred.'

  if (name === 'CorruptVaultError' || name === 'MalformedBlobError') {
    useVaultStore.setState({ error, status: 'recovering' })
    return
  }

  if (name.startsWith('Vault') || name === 'InsecureContextError') {
    useVaultStore.setState({ error })
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
