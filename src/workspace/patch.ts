export type PatchFailureCode = 'invalid_input' | 'no_match' | 'multiple_matches'

export type PatchPlan =
  | {
      ok: true
      content: string
      replacements: number
      linesChanged: number[]
      /** True when nothing changed because the desired text was already present. */
      alreadySatisfied?: boolean
    }
  | {
      ok: false
      code: PatchFailureCode
      message: string
      hint?: string
      lines?: number[]
    }

export interface PatchEdit {
  oldString: string
  newString: string
  replaceAll?: boolean
}

export interface PatchEditOutcome {
  index: number
  replacements: number
  linesChanged: number[]
  applied: boolean
  reason?: 'already_satisfied' | 'no_change'
}

export type PatchPlanMulti =
  | {
      ok: true
      content: string
      edits: PatchEditOutcome[]
      replacements: number
      linesChanged: number[]
      /** True when no edit applied because every requested change was already present. */
      alreadySatisfied: boolean
    }
  | {
      ok: false
      code: PatchFailureCode
      message: string
      hint?: string
      lines?: number[]
      failedIndex: number
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

function isEmptyNewStringAlreadyPresent(content: string, newString: string): boolean {
  return newString.length > 0 && content.includes(newString)
}

export function planPatch(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
  allowAlreadySatisfied = true,
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
    if (allowAlreadySatisfied && isEmptyNewStringAlreadyPresent(content, newString)) {
      return { ok: true, content, replacements: 0, linesChanged: [], alreadySatisfied: true }
    }
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

/**
 * Applies a batch of edits to one revision atomically. Every edit must succeed
 * against the evolving content or the whole batch fails with the failing index,
 * so a caller never persists a half-applied hunk list.
 */
export function planPatchMulti(content: string, edits: readonly PatchEdit[]): PatchPlanMulti {
  if (edits.length === 0) {
    return {
      ok: false,
      code: 'invalid_input',
      message: 'edits must contain at least one edit.',
      hint: 'Pass a non-empty list of {old_string, new_string} edits.',
      failedIndex: -1,
    }
  }

  let current = content
  const outcomes: PatchEditOutcome[] = []
  const changedLines: number[] = []
  let replacements = 0

  for (let index = 0; index < edits.length; index += 1) {
    const edit = edits[index]
    // Decide "already satisfied" against the ORIGINAL revision, not the evolving
    // one, so replaying an already-applied batch is idempotent without letting
    // an earlier hunk in the same batch insert the text a later hunk is judged by.
    const plan = planPatch(
      current,
      edit.oldString,
      edit.newString,
      edit.replaceAll === true,
      false,
    )
    if (!plan.ok) {
      if (plan.code === 'no_match' && isEmptyNewStringAlreadyPresent(content, edit.newString)) {
        outcomes.push({
          index,
          replacements: 0,
          linesChanged: [],
          applied: false,
          reason: 'already_satisfied',
        })
        continue
      }
      return {
        ok: false,
        code: plan.code,
        message: `Edit ${index}: ${plan.message}`,
        ...(plan.hint === undefined ? {} : { hint: plan.hint }),
        ...(plan.lines === undefined ? {} : { lines: plan.lines }),
        failedIndex: index,
      }
    }
    if (plan.replacements > 0) {
      current = plan.content
      replacements += plan.replacements
      changedLines.push(...plan.linesChanged)
      outcomes.push({
        index,
        replacements: plan.replacements,
        linesChanged: plan.linesChanged,
        applied: true,
      })
      continue
    }
    outcomes.push({
      index,
      replacements: 0,
      linesChanged: [],
      applied: false,
      reason: plan.alreadySatisfied ? 'already_satisfied' : 'no_change',
    })
  }

  const alreadySatisfied =
    replacements === 0 && outcomes.some((outcome) => outcome.reason === 'already_satisfied')

  return { ok: true, content: current, edits: outcomes, replacements, linesChanged: changedLines, alreadySatisfied }
}
