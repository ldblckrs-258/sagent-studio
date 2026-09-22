import { parseSlashInput } from '../chat/slash'

export type HighlightSegment = {
  text: string
  kind: 'plain' | 'command' | 'mention'
}

/**
 * Splits composer text into the runs the overlay paints.
 *
 * Only a *completed* token is highlighted: a slash command whose name resolves
 * to a registered entry, and a mention whose path is actually attached as a
 * chip. A half-typed `/comp` or an `@src/ch` stays plain, so the colour is a
 * statement that the thing exists rather than decoration on whatever was typed.
 */
export function highlightSegments(
  text: string,
  known: { commands: ReadonlySet<string>; paths: ReadonlySet<string> },
): HighlightSegment[] {
  const segments: HighlightSegment[] = []
  let cursor = 0

  const push = (kind: HighlightSegment['kind'], value: string) => {
    if (value === '') return
    const last = segments[segments.length - 1]
    if (last !== undefined && last.kind === kind && kind === 'plain') {
      last.text += value
      return
    }
    segments.push({ kind, text: value })
  }

  const command = completedCommandEnd(text, known.commands)
  if (command > 0) {
    // `parseSlashInput` trims the start, so the leading whitespace it ignores
    // is painted plain before the command itself.
    const start = text.length - text.trimStart().length
    push('plain', text.slice(0, start))
    push('command', text.slice(start, command))
    cursor = command
  }

  for (let index = cursor; index < text.length; index += 1) {
    if (text[index] !== '@') continue
    if (index > 0 && !/\s/.test(text[index - 1])) continue
    const end = endOfToken(text, index + 1)
    const path = text.slice(index + 1, end)
    if (!known.paths.has(path)) continue
    push('plain', text.slice(cursor, index))
    push('mention', text.slice(index, end))
    cursor = end
    index = end - 1
  }

  push('plain', text.slice(cursor))
  return segments
}

/** The index just past a leading `/name` that names a registered entry, or 0. */
function completedCommandEnd(
  text: string,
  commands: ReadonlySet<string>,
): number {
  const { isSlash, name } = parseSlashInput(text)
  if (!isSlash || name === '') return 0
  if (!commands.has(name)) return 0
  const start = text.length - text.trimStart().length
  return start + 1 + name.length
}

function endOfToken(text: string, from: number): number {
  let index = from
  while (index < text.length && !/\s/.test(text[index])) index += 1
  return index
}
