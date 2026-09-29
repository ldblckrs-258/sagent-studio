import { randomBytes } from 'node:crypto'
import { PAIR_FRAGMENT_KEY, PAIR_TOKEN_KEY } from './protocol.js'

export const PAIR_CODE_TTL_MS = 10 * 60 * 1000
export const MAX_LIVE_CODES = 5

export class PairCodes {
  private readonly codes = new Map<string, number>()

  mint(): string {
    this.prune()
    while (this.codes.size >= MAX_LIVE_CODES) {
      const oldest = this.codes.keys().next().value as string
      this.codes.delete(oldest)
    }
    const code = randomBytes(16).toString('base64url')
    this.codes.set(code, Date.now() + PAIR_CODE_TTL_MS)
    return code
  }

  consume(code: string | null | undefined): boolean {
    this.prune()
    if (!code || !this.codes.has(code)) return false
    this.codes.delete(code)
    return true
  }

  get size(): number {
    this.prune()
    return this.codes.size
  }

  private prune(): void {
    const now = Date.now()
    for (const [code, expiresAt] of this.codes) {
      if (expiresAt <= now) this.codes.delete(code)
    }
  }
}

export function pairUrl(port: number, code: string): string {
  return `http://127.0.0.1:${port}/pair?code=${code}`
}

export function pairRedirectLocation(appUrl: string, wsUrl: string, token: string): string {
  const url = new URL(appUrl)
  url.hash = `${PAIR_FRAGMENT_KEY}=${encodeURIComponent(wsUrl)}&${PAIR_TOKEN_KEY}=${encodeURIComponent(token)}`
  return url.href
}

export const PAIR_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
} as const

export const EXPIRED_PAGE =
  '<!doctype html><meta charset="utf-8"><title>sagent-bridge</title><p>Link expired. Press Enter in the sagent-bridge terminal for a new one.</p>'
