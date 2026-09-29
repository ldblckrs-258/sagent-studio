import { PAIR_FRAGMENT_KEY, PAIR_TOKEN_KEY } from 'sagent-bridge/protocol'
import { isTerminalBridgeUrl, isTerminalToken } from '../vault/settings'
import type { BridgeConfig } from './types'

let pending: BridgeConfig | null = null

export function parseBridgeConfig(url: string, token: string): BridgeConfig | null {
  const trimmedUrl = url.trim()
  const trimmedToken = token.trim()
  if (!isTerminalBridgeUrl(trimmedUrl) || !isTerminalToken(trimmedToken)) return null
  return { url: trimmedUrl, token: trimmedToken }
}

export function capturePairingFragment(win: Pick<Window, 'location' | 'history'>): boolean {
  const hash = win.location.hash
  if (!hash || hash.length < 2) return false
  const params = new URLSearchParams(hash.slice(1))
  if (!params.has(PAIR_FRAGMENT_KEY)) return false
  const { pathname, search } = win.location
  win.history.replaceState(win.history.state, '', `${pathname}${search}`)
  const config = parseBridgeConfig(params.get(PAIR_FRAGMENT_KEY) ?? '', params.get(PAIR_TOKEN_KEY) ?? '')
  if (!config) return false
  pending = config
  return true
}

export function peekPendingPair(): BridgeConfig | null {
  return pending
}

export function takePendingPair(): BridgeConfig | null {
  const value = pending
  pending = null
  return value
}

export function clearPendingPair(): void {
  pending = null
}
