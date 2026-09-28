import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useDocumentLibraryStore } from '../rag/library-state'
import { useMemoryStore } from '../memory/state'
import { isDatabaseBlocked, subscribeDatabaseBlocked } from '../vault/db'
import { startRagIndex } from '../rag/lifecycle'
import { createSession } from './session'
import { SessionContext } from './session-context'
import { useWorkspaceStore } from './workspace-state'

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * Owns the app session for one vault unlock. Hydration and workspace restore
 * are best-effort: a failure surfaces as a non-fatal banner rather than
 * blocking the shell, so the thread still renders.
 */
/**
 * Surfaces the Dexie `blocked` event: another tab is holding an older schema, so
 * a version upgrade cannot finish until that tab closes.
 */
function DatabaseBlockedNotice() {
  const [blocked, setBlocked] = useState(isDatabaseBlocked)
  useEffect(() => subscribeDatabaseBlocked(() => setBlocked(true)), [])
  if (!blocked) return null
  return (
    <div
      role="alert"
      className="border-b border-danger-rule bg-danger-soft px-6 py-2 font-mono text-xs text-danger"
    >
      Close the other tabs running sagent-studio so the database upgrade can finish.
    </div>
  )
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session] = useState(createSession)
  const [sessionError, setSessionError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const ragAbort = new AbortController()
    let stopRagIndex: (() => void) | undefined
    void (async () => {
      const failures: string[] = []
      try {
        await session.skillRegistry.hydrate()
      } catch (error) {
        failures.push(describe(error))
      }
      try {
        await session.toolRegistry.hydrate()
      } catch (error) {
        failures.push(describe(error))
      }
      if (!cancelled) void session.startMcp()
      await useMemoryStore.getState().hydrate()
      const memoryError = useMemoryStore.getState().error
      if (memoryError) failures.push(memoryError)
      try {
        await useWorkspaceStore.getState().restore()
      } catch (error) {
        failures.push(describe(error))
      }
      try {
        stopRagIndex = await startRagIndex({ signal: ragAbort.signal })
      } catch (error) {
        // An abort from this effect's own unmount is not a failure. Under
        // StrictMode the first mount aborts and remounts; the generation stamp
        // and abort check keep that safe.
        if (!isAbortError(error) && !ragAbort.signal.aborted) failures.push(describe(error))
      }
      if (!cancelled && failures.length > 0) setSessionError(failures.join(' '))
    })()

    return () => {
      cancelled = true
      // Abort an in-flight hydrate before clearing so it cannot write into the
      // index after shutdown; an already-hydrated index is cleared by stop().
      ragAbort.abort()
      stopRagIndex?.()
      useDocumentLibraryStore.getState().clear()
      useMemoryStore.getState().clear()
      session.dispose()
      void useWorkspaceStore.getState().clear()
    }
  }, [session])

  return (
    <SessionContext.Provider value={session}>
      <DatabaseBlockedNotice />
      {sessionError ? (
        <div
          role="alert"
          className="border-b border-danger-rule bg-danger-soft px-6 py-2 font-mono text-xs text-danger"
        >
          {sessionError}
        </div>
      ) : null}
      {children}
    </SessionContext.Provider>
  )
}
