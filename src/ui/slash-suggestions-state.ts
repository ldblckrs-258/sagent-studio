import { parseSlashInput } from "../chat/slash";
import type { SlashEntry } from "../chat/slash";

/**
 * Keyboard and completion behavior for the slash popover, kept out of the
 * component because vitest runs with `environment: "node"` here and components
 * are asserted through `renderToStaticMarkup`. This mirrors the split the
 * repository already uses for `plan-view.ts` and `resize.ts`: the logic is
 * testable, and the component is only markup.
 */

/** Empty whenever the composer text is not a command, so the popover stays shut. */
export function suggestionsFor(
  entries: readonly SlashEntry[],
  text: string,
): SlashEntry[] {
  const { isSlash, name, args } = parseSlashInput(text);
  if (!isSlash) return [];
  // Once the name is settled and arguments have started, the list has served
  // its purpose and would only cover the composer.
  if (args.length > 0 || /\s$/.test(text)) return [];
  if (name.length === 0) return [...entries];
  const needle = name.toLowerCase();
  return entries.filter((entry) => entry.id.toLowerCase().startsWith(needle));
}

/** Wraps at both ends, so the list is navigable without reaching for the mouse. */
export function moveHighlight(
  state: { highlight: number; count: number },
  direction: 1 | -1,
): number {
  if (state.count <= 0) return 0;
  return (state.highlight + direction + state.count) % state.count;
}

/**
 * The composer text after a selection. The entry's own id already carries an
 * `@workspace` suffix when the name is ambiguous, so completing it is what
 * makes the duplicate reachable. Arguments already typed are preserved, and an
 * entry that takes them gets a trailing space to type into.
 */
export function completionFor(entry: SlashEntry, text: string): string {
  const { args } = parseSlashInput(text);
  if (args.length > 0) return `/${entry.id} ${args}`;
  return entry.argumentHint !== undefined ? `/${entry.id} ` : `/${entry.id}`;
}
