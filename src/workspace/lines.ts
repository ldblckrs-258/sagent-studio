export interface LineWindow {
  content: string
  totalLines: number
  returnedLines: number
  offset: number
  truncated: boolean
}

export interface SliceLinesOptions {
  offset?: number
  limit?: number
}

export function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function countLines(text: string): number {
  return splitLines(text).length
}

export function sliceLines(text: string, options: SliceLinesOptions = {}): LineWindow {
  const lines = splitLines(text)
  const totalLines = lines.length
  const requestedOffset = options.offset
  const offset =
    requestedOffset === undefined || !Number.isFinite(requestedOffset)
      ? 1
      : Math.max(1, Math.trunc(requestedOffset))
  const requestedLimit = options.limit
  const limit =
    requestedLimit === undefined || !Number.isFinite(requestedLimit)
      ? totalLines
      : Math.max(0, Math.trunc(requestedLimit))
  const start = offset - 1
  const window = start >= totalLines ? [] : lines.slice(start, start + limit)
  const returnedLines = window.length
  const truncated = returnedLines > 0 && start + returnedLines < totalLines
  return {
    content: window.join('\n'),
    totalLines,
    returnedLines,
    offset,
    truncated,
  }
}
