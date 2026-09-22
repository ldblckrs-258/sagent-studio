import { groupPartByType } from "@assistant-ui/react";
import type { GroupByContext, PartState } from "@assistant-ui/react";

/**
 * Which tool calls render on their own in the transcript rather than folding
 * into the "N tool calls" disclosure, and the `groupBy` the thread hands to
 * `MessagePrimitive.GroupedParts`.
 *
 * Two reasons a call stands alone:
 * - by name, for a call the user is meant to read or act on (a file preview, a
 *   plan, a mode change);
 * - by status, for a call waiting on the user (an approval or an interrupt), so
 *   a decision never sits hidden inside a collapsed group while the run stalls.
 */
export const STANDALONE_TOOL_NAMES = [
  "open_preview",
  "update_plan",
  "change_mode",
] as const;

export type ThreadGroupKey =
  | "group-chainOfThought"
  | "group-reasoning"
  | "group-tool"
  | "group-task";

/** The shape the policy needs; `PartState` satisfies it. */
interface GroupablePart {
  type: string;
  toolName?: string | undefined;
  status?: { type: string } | undefined;
  messages?: unknown;
}

export function isStandaloneToolCall(part: GroupablePart): boolean {
  if (part.type !== "tool-call") return false;
  if (part.status?.type === "requires-action") return true;
  return (
    part.toolName !== undefined &&
    (STANDALONE_TOOL_NAMES as readonly string[]).includes(part.toolName)
  );
}

const messageGroupBy = groupPartByType({
  reasoning: ["group-chainOfThought", "group-reasoning"],
  "tool-call": ["group-chainOfThought", "group-tool"],
  "standalone-tool-call": [],
});

const TASK_GROUP_PATH: readonly ThreadGroupKey[] = [
  "group-chainOfThought",
  "group-task",
];

function baseGroupPath(
  part: GroupablePart,
  context?: GroupByContext,
): readonly ThreadGroupKey[] {
  if (isStandaloneToolCall(part)) return [];
  return messageGroupBy(part as PartState, context) as readonly ThreadGroupKey[];
}

/** Grouping when no `TaskGroup` override is set. */
export function threadGroupBy(
  part: GroupablePart,
  context?: GroupByContext,
): readonly ThreadGroupKey[] {
  return baseGroupPath(part, context);
}

/**
 * Grouping when a `TaskGroup` override is set. A tool call that carries a
 * nested conversation and has no registered UI renders through that group; a
 * standalone call still renders on its own.
 */
export function taskAwareGroupBy(
  part: GroupablePart,
  context?: GroupByContext,
): readonly ThreadGroupKey[] {
  const typed = part as PartState;
  const path = baseGroupPath(part, context);
  return typed.type === "tool-call" &&
    typed.messages !== undefined &&
    path.length > 0 &&
    !context?.toolUIs?.[typed.toolName]?.length
    ? TASK_GROUP_PATH
    : path;
}
