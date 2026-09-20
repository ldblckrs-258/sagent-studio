import { planCounts } from "../chat/plan";
import type { PlanItem } from "../chat/types";

/**
 * What the collapsed plan strip reports: the step in flight, otherwise the step
 * the agent will pick up next. `done` and `halted` are distinguished so a plan
 * that ended with cancellations never claims to be complete.
 */
export type PlanPreview =
  | { kind: "now"; item: PlanItem }
  | { kind: "next"; item: PlanItem }
  | { kind: "done" }
  | { kind: "halted" };

/** Reads an empty plan as `null`: there is nothing to report and nothing to render. */
export function planPreview(items: readonly PlanItem[]): PlanPreview | null {
  if (items.length === 0) return null;
  const active = items.find((item) => item.status === "in_progress");
  if (active) return { kind: "now", item: active };
  const queued = items.find((item) => item.status === "pending");
  if (queued) return { kind: "next", item: queued };
  return items.some((item) => item.status === "cancelled")
    ? { kind: "halted" }
    : { kind: "done" };
}

export interface PlanSummary {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  cancelled: number;
  /** Steps the agent has not resolved yet: pending plus in progress. */
  open: number;
}

/** Counts on top of the domain's `planCounts`, adding the totals the panel needs. */
export function planSummary(items: readonly PlanItem[]): PlanSummary {
  const counts = planCounts(items);
  return {
    total: items.length,
    pending: counts.pending,
    inProgress: counts.in_progress,
    completed: counts.completed,
    cancelled: counts.cancelled,
    open: counts.pending + counts.in_progress,
  };
}
