import stripAnsi from 'strip-ansi'

const PARTIAL_CSI = /^(?:\[[0-9;?]*|[0-9;?]+)[A-Za-z@`~]/
const BEL = String.fromCharCode(7)
const ST = `${String.fromCharCode(27)}\\`

function stripPartialEscape(text: string): string {
  if (!text.startsWith(']')) return text.replace(PARTIAL_CSI, '')
  const bel = text.indexOf(BEL)
  const st = text.indexOf(ST)
  if (bel === -1 && st === -1) return text
  if (st === -1 || (bel !== -1 && bel < st)) return text.slice(bel + 1)
  return text.slice(st + ST.length)
}

function applyBackspaces(line: string): string {
  if (!line.includes('\b')) return line
  const out: string[] = []
  for (const char of line) {
    if (char === '\b') out.pop()
    else out.push(char)
  }
  return out.join('')
}

function lastSegment(line: string): string {
  if (!line.includes('\r')) return line
  const segments = line.split('\r')
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].length > 0) return segments[i]
  }
  return ''
}

export function toPlain(bytes: Buffer, midStream: boolean): string {
  let text = bytes.toString('utf8')
  if (midStream) text = stripPartialEscape(text)
  text = stripAnsi(text).replace(/\r+\n/g, '\n')
  return text
    .split('\n')
    .map((line) => applyBackspaces(lastSegment(line)))
    .join('\n')
}
