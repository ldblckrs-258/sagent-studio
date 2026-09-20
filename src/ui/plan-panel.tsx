import {
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  ListChecks,
  LoaderCircle,
} from "lucide-react";
import { useState } from "react";
import { useChatStore } from "../chat/store";
import type { PlanItemStatus } from "../chat/types";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import type { PlanPreview } from "./plan-view";
import { planPreview, planSummary } from "./plan-view";

const PLAN_STATE_KEY = "sagent.plan.v1";

/*
  State is carried by glyph shape and glyph colour together, never by colour
  alone: the four circles stay distinguishable in greyscale and for readers with
  a colour vision deficiency. Step text stays on `muted` (5.2:1 against the
  sunken panel) so no row falls below AA, and the eye reads status from the
  glyph column plus the weight of the step in flight.
*/
const GLYPH: Record<PlanItemStatus, typeof CircleDashed> = {
  pending: CircleDashed,
  in_progress: LoaderCircle,
  completed: CircleCheck,
  cancelled: CircleSlash,
};

const GLYPH_TONE: Record<PlanItemStatus, string> = {
  pending: "text-faint",
  in_progress: "text-caution",
  completed: "text-positive",
  cancelled: "text-faint",
};

const TEXT_TONE: Record<PlanItemStatus, string> = {
  pending: "text-muted",
  in_progress: "text-ink font-medium",
  completed: "text-muted",
  cancelled: "text-muted line-through",
};

const STATUS_WORD: Record<PlanItemStatus, string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

/** Left-to-right reading order of the header meter: done, doing, dropped. */
const METER_PARTS = [
  { key: "completed", tone: "bg-positive" },
  { key: "in_progress", tone: "bg-caution" },
  { key: "cancelled", tone: "bg-danger" },
] as const;

function readPlanOpen(): boolean {
  if (typeof sessionStorage === "undefined") return false;
  try {
    return sessionStorage.getItem(PLAN_STATE_KEY) === "open";
  } catch {
    return false;
  }
}

function writePlanOpen(open: boolean): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(PLAN_STATE_KEY, open ? "open" : "collapsed");
  } catch {
    // A blocked session store must never take the chat surface down with it.
  }
}

function StatusGlyph({
  status,
  spinning = false,
}: {
  status: PlanItemStatus;
  spinning?: boolean;
}) {
  const Icon = GLYPH[status];
  return (
    <Icon
      aria-hidden="true"
      size={14}
      strokeWidth={1.75}
      className={`shrink-0 ${GLYPH_TONE[status]}${
        spinning && status === "in_progress"
          ? " animate-spin motion-reduce:animate-none"
          : ""
      }`}
    />
  );
}

/** The step the collapsed strip reports, plus the words a screen reader needs. */
function stripGlyph(preview: PlanPreview, spinning: boolean) {
  if (preview.kind === "now" || preview.kind === "next") {
    return <StatusGlyph status={preview.item.status} spinning={spinning} />;
  }
  if (preview.kind === "done") {
    return (
      <CircleCheck
        aria-hidden="true"
        size={14}
        strokeWidth={1.75}
        className="text-positive"
      />
    );
  }
  return (
    <CircleSlash
      aria-hidden="true"
      size={14}
      strokeWidth={1.75}
      className="text-faint"
    />
  );
}

function stripText(preview: PlanPreview) {
  if (preview.kind === "done") return "All steps complete.";
  if (preview.kind === "halted") return "No steps left open.";
  return (
    <>
      <span className="sr-only">
        {preview.kind === "now" ? "In progress: " : "Next: "}
      </span>
      {preview.item.text}
    </>
  );
}

/**
 * The active thread's model-authored plan.
 *
 * Collapsed by default, because the panel sits in fixed chrome above the
 * conversation and a long plan would otherwise tax every reading task. The
 * collapsed strip still reports the live step, so staying compact costs the
 * reader nothing; the choice persists for the session like the sidebar's does.
 */
export function PlanPanel() {
  const [open, setOpen] = useState(readPlanOpen);
  const plan = useChatStore((s) =>
    s.activeThreadId ? s.threads[s.activeThreadId]?.plan : undefined,
  );
  const running = useChatStore((s) =>
    s.activeThreadId ? (s.runningThreads[s.activeThreadId] ?? 0) > 0 : false,
  );
  if (!plan || plan.length === 0) return null;

  const preview = planPreview(plan);
  const summary = planSummary(plan);
  const complete = summary.open === 0 && summary.cancelled === 0;
  const meterCount = {
    completed: summary.completed,
    in_progress: summary.inProgress,
    cancelled: summary.cancelled,
  };

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        writePlanOpen(next);
      }}
      /*
        Capped and centred so the panel shares the conversation column's axis
        (the thread column is 44rem, four pixels wider than this cap) instead of
        running the width of the window. The calc keeps a gutter on phones.
      */
      className="mx-auto mt-2 w-[calc(100%-1.5rem)] max-w-200 rounded-sm border border-rule bg-paper-sunk"
    >
      <CollapsibleTrigger className="flex w-full flex-col text-left transition-colors duration-150 ease-out-quart hover:bg-paper">
        <span className="flex min-h-9 w-full items-center gap-2 px-3">
          <ListChecks
            aria-hidden="true"
            size={14}
            strokeWidth={1.75}
            className="shrink-0 text-accent"
          />
          {/* Mirrors `.label-micro`, on `muted` so the label clears AA on this panel. */}
          <span className="font-mono text-xs tracking-[0.08em] text-muted uppercase">
            Plan
          </span>
          <span
            aria-hidden="true"
            className={`numeric font-mono text-xs ${complete ? "text-positive" : "text-ink"}`}
          >
            {summary.completed}/{summary.total}
          </span>
          <span className="sr-only">
            {summary.completed} of {summary.total} steps completed
          </span>
          <span
            aria-hidden="true"
            className="ml-1 flex h-1 max-w-24 min-w-10 flex-1 overflow-hidden rounded-sm bg-rule"
          >
            {METER_PARTS.map(({ key, tone }) => {
              const count = meterCount[key];
              if (count === 0) return null;
              return (
                <span
                  key={key}
                  // A 3px floor keeps a single step visible in a fifty-item plan,
                  // where a true proportional slice would round away to nothing.
                  style={{
                    width: `${(count / summary.total) * 100}%`,
                    minWidth: "3px",
                  }}
                  className={`h-full ${tone}`}
                />
              );
            })}
          </span>
          <ChevronDown
            aria-hidden="true"
            size={14}
            strokeWidth={1.75}
            className={`ml-auto shrink-0 text-faint transition-transform duration-200 ease-out-quart motion-reduce:transition-none ${
              open ? "rotate-0" : "-rotate-90"
            }`}
          />
        </span>

        {open || preview === null ? null : (
          <span className="rule-top flex w-full items-center gap-2 px-3 py-1">
            <span className="flex h-5 w-3.5 shrink-0 items-center justify-center">
              {stripGlyph(preview, running)}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs leading-5 text-muted">
              {stripText(preview)}
            </span>
          </span>
        )}
      </CollapsibleTrigger>

      <CollapsibleContent className="overflow-hidden motion-reduce:animate-none data-open:animate-collapsible-down data-closed:animate-collapsible-up data-closed:pointer-events-none data-closed:fill-mode-forwards">
        <ol className="max-h-72 overflow-y-auto overscroll-contain px-2 pb-2">
          {plan.map((item) => (
            <li key={item.id} className="flex items-start gap-2 py-1">
              <span className="flex h-5 w-3.5 shrink-0 items-center justify-center">
                <StatusGlyph status={item.status} spinning={running} />
              </span>
              <span className={`text-xs leading-5 ${TEXT_TONE[item.status]}`}>
                <span className="sr-only">{STATUS_WORD[item.status]}: </span>
                {item.text}
              </span>
            </li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}
