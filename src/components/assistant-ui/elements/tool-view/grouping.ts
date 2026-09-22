import { groupPartByType } from "@assistant-ui/react";
import type { GroupByContext, PartState } from "@assistant-ui/react";

/**
 * The thread's `groupBy`. Tool calls are never folded into a disclosure: each
 * one renders on its own, in order, so the user sees every call the model made.
 * Only reasoning coalesces. A host that supplies a `TaskGroup` can additionally
 * route a tool call carrying a nested conversation through it.
 */
export type ThreadGroupKey =
  | "group-chainOfThought"
  | "group-reasoning"
  | "group-tool"
  | "group-task";

/** The shape the policy reads; `PartState` satisfies it. */
interface GroupablePart {
  type: string;
  toolName?: string | undefined;
  status?: { type: string } | undefined;
  messages?: unknown;
}

const messageGroupBy = groupPartByType({
  reasoning: ["group-chainOfThought", "group-reasoning"],
  "tool-call": [],
  "standalone-tool-call": [],
});

const TASK_GROUP_PATH: readonly ThreadGroupKey[] = [
  "group-chainOfThought",
  "group-task",
];

/** Grouping used when no `TaskGroup` override is set. */
export function threadGroupBy(
  part: GroupablePart,
  context?: GroupByContext,
): readonly ThreadGroupKey[] {
  return messageGroupBy(part as PartState, context) as readonly ThreadGroupKey[];
}

/**
 * Grouping used when a `TaskGroup` override is set. A tool call that carries a
 * nested conversation and has no registered UI renders through that group;
 * every other call still renders on its own.
 */
export function taskAwareGroupBy(
  part: GroupablePart,
  context?: GroupByContext,
): readonly ThreadGroupKey[] {
  const typed = part as PartState;
  const path = threadGroupBy(part, context);
  return typed.type === "tool-call" &&
    typed.messages !== undefined &&
    !context?.toolUIs?.[typed.toolName]?.length
    ? TASK_GROUP_PATH
    : path;
}
