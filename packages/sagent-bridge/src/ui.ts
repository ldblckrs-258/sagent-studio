import stripAnsi from 'strip-ansi'

const ESC = String.fromCharCode(27)

const CODES = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  gray: [90, 39],
} as const

export type Color = keyof typeof CODES
export type Paint = (color: Color, text: string) => string

export function supportsColor(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR) return false
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true
  return stream.isTTY === true && env.TERM !== 'dumb'
}

export function painter(enabled: boolean): Paint {
  if (!enabled) return (_color, text) => text
  return (color, text) => `${ESC}[${CODES[color][0]}m${text}${ESC}[${CODES[color][1]}m`
}

export function visibleWidth(text: string): number {
  return [...stripAnsi(text)].length
}

export function box(lines: readonly string[], paint: Paint, maxWidth: number = Infinity): string {
  const inner = Math.max(0, ...lines.map(visibleWidth))
  if (inner + 6 > maxWidth) return lines.map((line) => `  ${line}\n`).join('')
  const edge = (text: string): string => paint('gray', text)
  const rule = '─'.repeat(inner + 4)
  const rows = lines.map((line) => `${edge('│')}  ${line}${' '.repeat(inner - visibleWidth(line))}  ${edge('│')}`)
  return [edge(`╭${rule}╮`), ...rows, edge(`╰${rule}╯`)].map((row) => `${row}\n`).join('')
}

export function tildify(path: string, home: string): string {
  if (!home || home === '/') return path
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

export function clock(date: Date = new Date()): string {
  return date.toTimeString().slice(0, 8)
}
