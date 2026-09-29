import type { InputOrigin } from './protocol.js'

export interface TrackedLine {
  line: string
  opaque: boolean
}

interface State {
  line: string
  opaque: boolean
}

function escapeLength(data: string, start: number): number {
  const next = data[start + 1]
  if (next === undefined) return 1
  if (next === '[') {
    let i = start + 2
    while (i < data.length) {
      const code = data.charCodeAt(i)
      i++
      if (code >= 0x40 && code <= 0x7e) break
    }
    return i - start
  }
  if (next === ']') {
    let i = start + 2
    while (i < data.length) {
      if (data[i] === '\x07') return i + 1 - start
      if (data[i] === '\x1b' && data[i + 1] === '\\') return i + 2 - start
      i++
    }
    return i - start
  }
  if (next === 'O') return Math.min(3, data.length - start)
  return 2
}

function feed(state: State, data: string): TrackedLine[] {
  const submitted: TrackedLine[] = []
  for (let i = 0; i < data.length; i++) {
    const char = data[i]
    const code = data.charCodeAt(i)
    if (char === '\r' || char === '\n') {
      if (char === '\n' && data[i - 1] === '\r') continue
      submitted.push({ line: state.line, opaque: state.opaque })
      state.line = ''
      state.opaque = false
    } else if (char === '\x03') {
      state.line = ''
      state.opaque = false
    } else if (char === '\x15' && !state.opaque) {
      state.line = ''
    } else if (char === '\x7f' || char === '\b') {
      state.line = [...state.line].slice(0, -1).join('')
    } else if (char === '\x04' && state.line === '' && !state.opaque) {
      continue
    } else if (char === '\x1b') {
      state.opaque = true
      i += escapeLength(data, i) - 1
    } else if (code < 0x20) {
      state.opaque = true
    } else {
      state.line += char
    }
  }
  return submitted
}

export class LineTracker {
  private readonly state: State = { line: '', opaque: false }
  private version = 0

  get inputVersion(): number {
    return this.version
  }

  simulate(data: string): { submitted: TrackedLine[]; pending: TrackedLine } {
    const copy = { ...this.state }
    const submitted = feed(copy, data)
    return { submitted, pending: { ...copy } }
  }

  apply(data: string, origin: InputOrigin): void {
    this.version++
    feed(this.state, data)
    if (origin === 'user' && this.state.line.length > 0) this.state.opaque = true
  }

  get pending(): TrackedLine {
    return { ...this.state }
  }
}

const ANSWERS = /^(y|n|yes|no|q|)$/i

export function isPlainAnswer(line: TrackedLine): boolean {
  return !line.opaque && ANSWERS.test(line.line.trim())
}
