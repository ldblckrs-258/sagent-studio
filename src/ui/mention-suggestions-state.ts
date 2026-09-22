/**
 * Caret-side behavior for the `@` popover, kept out of the component for the
 * same reason `slash-suggestions-state.ts` is: the logic is testable in the
 * node environment, and the component is only markup.
 *
 * A mention can sit anywhere in the text, so unlike the slash popover this has
 * to know where the caret is. Composer state never publishes it —
 * `ComposerPrimitive.Input` hands `selectionStart` to the plugin registry
 * alone — so the wrapper reads it off the textarea and passes it here.
 */

export type MentionQuery = {
  /** The text between `@` and the caret. */
  query: string
  /** Index of the `@` itself. */
  start: number
  /** Index just past the caret, where the completion ends. */
  end: number
}

/**
 * The mention being typed at `caret`, or null.
 *
 * The `@` has to open a word — start of text or after whitespace — so an email
 * address or a decorator mid-word never opens the list, and the query itself
 * cannot contain whitespace.
 */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const bounded = Math.max(0, Math.min(caret, text.length))
  const before = text.slice(0, bounded)
  const at = before.lastIndexOf('@')
  if (at === -1) return null
  if (at > 0 && !/\s/.test(before[at - 1])) return null
  const query = before.slice(at + 1)
  if (/\s/.test(query)) return null
  return { query, start: at, end: bounded }
}

/**
 * The composer text after a mention is taken, and where the caret belongs.
 *
 * `descend` is the folder case: the path is inserted with a trailing slash and
 * no space, so the query becomes `folder/` and the popover keeps listing that
 * folder's children instead of closing on a directory the user was only
 * passing through. A completion ends with a space, which closes the popover
 * because a query can no longer contain whitespace.
 */
export function completeMention(
  text: string,
  match: MentionQuery,
  path: string,
  options: { descend?: boolean } = {},
): { text: string; caret: number } {
  const rest = text.slice(match.end)
  if (options.descend === true) {
    const completion = `@${path}/`
    return {
      text: `${text.slice(0, match.start)}${completion}${rest}`,
      caret: match.start + completion.length,
    }
  }
  // No second space when the text already continues with one, so completing
  // mid-sentence does not leave a gap.
  const spaced = /^\s/.test(rest)
  const completion = spaced ? `@${path}` : `@${path} `
  return {
    text: `${text.slice(0, match.start)}${completion}${rest}`,
    caret: match.start + completion.length + (spaced ? 1 : 0),
  }
}
