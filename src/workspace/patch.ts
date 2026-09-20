export type PatchFailureCode = 'invalid_input' | 'no_match' | 'multiple_matches'

export type PatchPlan =
  | {
      ok: true
      content: string
      replacements: number
      linesChanged: number[]
    }
  | {
      ok: false
      code: PatchFailureCode
      message: string
      hint?: string
      lines?: number[]
    }

function lineNumberAt(content: string, index: number): number {
  let line = 1
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content.charCodeAt(cursor) === 10) line += 1
  }
  return line
}

export function countOccurrences(content: string, needle: string): number[] {
  const lines: number[] = []
  if (needle.length === 0) return lines
  let cursor = 0
  while (cursor <= content.length - needle.length) {
    const index = content.indexOf(needle, cursor)
    if (index === -1) break
    lines.push(lineNumberAt(content, index))
    cursor = index + needle.length
  }
  return lines
}

function replaceOnce(content: string, oldString: string, newString: string): string {
  const index = content.indexOf(oldString)
  if (index === -1) return content
  return content.slice(0, index) + newString + content.slice(index + oldString.length)
}

export function planPatch(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): PatchPlan {
  if (oldString.length === 0) {
    return {
      ok: false,
      code: 'invalid_input',
      message: 'old_string must not be empty.',
      hint: 'Provide the exact non-empty text to replace.',
    }
  }

  if (oldString === newString) {
    return { ok: true, content, replacements: 0, linesChanged: [] }
  }

  const lines = countOccurrences(content, oldString)
  if (lines.length === 0) {
    return {
      ok: false,
      code: 'no_match',
      message: 'old_string does not appear in the file.',
      hint: 'Re-read the file and copy the exact text, including whitespace.',
    }
  }
  if (lines.length > 1 && !replaceAll) {
    return {
      ok: false,
      code: 'multiple_matches',
      message: `old_string appears ${lines.length} times in the file.`,
      hint: `Matches are on lines ${lines.join(', ')}. Set replace_all to true or include more surrounding context.`,
      lines,
    }
  }

  const next = replaceAll ? content.split(oldString).join(newString) : replaceOnce(content, oldString, newString)
  return { ok: true, content: next, replacements: lines.length, linesChanged: lines }
}
