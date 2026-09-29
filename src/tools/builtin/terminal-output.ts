export const RUN_COMMAND_MAX_CHARS = 30_000
export const DEFAULT_READ_CHARS = 20_000
export const IDLE_MS = 400

export interface Truncated {
  text: string
  truncated: boolean
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

export function truncateMiddle(text: string, maxChars: number): Truncated {
  if (text.length <= maxChars) return { text, truncated: false }
  let head = Math.floor(maxChars * 0.4)
  let tailStart = text.length - (maxChars - head)
  if (head > 0 && isLowSurrogate(text.charCodeAt(head))) head -= 1
  if (tailStart < text.length && isLowSurrogate(text.charCodeAt(tailStart))) tailStart += 1
  const omitted = tailStart - head
  return {
    text: `${text.slice(0, head)}…[${omitted} chars omitted]…${text.slice(tailStart)}`,
    truncated: true,
  }
}

export type QuietOutcome = 'idle' | 'deadline' | 'exit' | 'aborted'

export interface QuietOptions {
  watch(onEvent: () => void): () => void
  isDone(): boolean
  waitMs: number
  idleMs?: number
  signal?: AbortSignal
}

export function waitForQuiet(options: QuietOptions): Promise<QuietOutcome> {
  return new Promise((resolve) => {
    const idleMs = options.idleMs ?? IDLE_MS
    let settled = false
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let stopWatching: () => void = () => {}
    const finish = (outcome: QuietOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(idleTimer)
      clearTimeout(deadline)
      stopWatching()
      options.signal?.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const onAbort = () => finish('aborted')
    const armIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => finish('idle'), idleMs)
    }
    const deadline = setTimeout(() => finish('deadline'), options.waitMs)
    if (options.signal?.aborted) return finish('aborted')
    options.signal?.addEventListener('abort', onAbort, { once: true })
    stopWatching = options.watch(() => {
      if (options.isDone()) finish('exit')
      else armIdle()
    })
    if (options.isDone()) return finish('exit')
    armIdle()
  })
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}
