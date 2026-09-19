import { createContext, useContext } from 'react'
import type { AppSession } from './session'

export const SessionContext = createContext<AppSession | null>(null)

export function useSession(): AppSession {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useSession must be used inside SessionProvider.')
  return session
}
