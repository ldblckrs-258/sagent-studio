import { useEffect, useState, useSyncExternalStore } from 'react'
import type { SessionInfo } from 'sagent-bridge/protocol'
import { agentRunStore } from '../../agents/store'
import type { BridgeView, TerminalPort } from '../../terminal/types'

export const DROPPED_NOTICE = '\x1b[2m[earlier output dropped]\x1b[0m\r\n'
const SELECTION_KEY = 'sagent.terminal.selected'

export function useBridgeView(port: TerminalPort): BridgeView {
  return useSyncExternalStore(
    (listener) => port.onChange(listener),
    () => port.view(),
  )
}

export function useNow(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs, active])
  return now
}

export function attachSession(
  port: TerminalPort,
  sessionId: string,
  write: (data: Uint8Array | string) => void,
): () => void {
  let first = true
  return port.subscribe(
    sessionId,
    (bytes, offset) => {
      if (first) {
        first = false
        if (offset > 0) write(DROPPED_NOTICE)
      }
      write(bytes)
    },
    0,
  )
}

export function ownerLabel(session: SessionInfo): string {
  if (session.owner.source === 'user') return 'you'
  if (session.owner.source === 'model') return 'model'
  const runId = session.owner.runId
  const label = runId ? agentRunStore.get(runId)?.label : undefined
  return `agent: ${label ?? runId?.slice(0, 8) ?? 'unknown'}`
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function readSelection(sessions: readonly SessionInfo[]): string | null {
  let stored: string | null = null
  try {
    stored = sessionStorage.getItem(SELECTION_KEY)
  } catch {
    stored = null
  }
  if (stored && sessions.some((session) => session.id === stored)) return stored
  return sessions[0]?.id ?? null
}

export function rememberSelection(id: string): void {
  try {
    sessionStorage.setItem(SELECTION_KEY, id)
  } catch {
    return
  }
}
