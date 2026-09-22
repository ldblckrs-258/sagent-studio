import {
  Braces,
  CircleCheck,
  Circle,
  CircleDot,
  CircleSlash,
  ListChecks,
  RefreshCcw,
  ShieldHalf,
  Terminal,
} from "lucide-react";
import {
  ToolCode,
  ToolKeyValues,
  ToolSection,
  type ToolDetailProps,
  type ToolViewSpec,
} from "../primitives";
import { asArray, asNumber, asRecord, asString } from "../helpers";
import { cn } from "@/lib/utils";

const PLAN_STATUS = {
  pending: { icon: Circle, label: "pending" },
  in_progress: { icon: CircleDot, label: "in progress" },
  completed: { icon: CircleCheck, label: "completed" },
  cancelled: { icon: CircleSlash, label: "cancelled" },
} as const;

function SourceAndOutput({ envelope }: ToolDetailProps) {
  const value = asRecord(envelope?.value);
  const stdout = asString(value.stdout) ?? "";
  const stderr = asString(value.stderr) ?? "";
  const result = asString(value.result);
  return (
    <div className="flex flex-col gap-2">
      {stdout.length > 0 && (
        <ToolSection label="stdout">
          <ToolCode text={stdout} limit={200} />
        </ToolSection>
      )}
      {stderr.length > 0 && (
        <ToolSection label="stderr">
          <ToolCode text={stderr} limit={200} className="border-danger-rule bg-danger-soft text-danger" />
        </ToolSection>
      )}
      {result !== null && result !== undefined && result.length > 0 && (
        <ToolSection label="result">
          <ToolCode text={result} limit={80} />
        </ToolSection>
      )}
      {stdout.length === 0 &&
        stderr.length === 0 &&
        (result === null || result === undefined) && (
          <p className="text-faint text-xs">The run produced no output.</p>
        )}
    </div>
  );
}

function runDetail({ args, envelope }: ToolDetailProps) {
  const source = asString(args.source);
  return (
    <div className="flex flex-col gap-3">
      {source !== undefined && source.length > 0 && (
        <ToolSection label="Source">
          <ToolCode text={source} limit={120} />
        </ToolSection>
      )}
      <SourceAndOutput args={args} envelope={envelope} />
    </div>
  );
}

function planDetail({ envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  const value = asRecord(envelope.value);
  const items = asArray(value.items).map(asRecord);
  const notice = asString(value.notice);
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-1">
        {items.map((item, index) => {
          const status = asString(item.status) ?? "pending";
          const spec = PLAN_STATUS[status as keyof typeof PLAN_STATUS] ?? PLAN_STATUS.pending;
          const Icon = spec.icon;
          return (
            <li
              key={asString(item.id) ?? index}
              className="flex min-w-0 items-start gap-2 text-xs"
            >
              <Icon
                className={cn(
                  "mt-0.5 size-3.5 shrink-0",
                  status === "completed" && "text-positive",
                  status === "in_progress" && "text-accent",
                  status === "cancelled" && "text-muted",
                  status === "pending" && "text-faint",
                )}
                aria-hidden="true"
              />
              <span
                className={cn(
                  "min-w-0 leading-relaxed",
                  status === "cancelled" && "text-muted line-through",
                  status === "completed" && "text-muted",
                  status !== "cancelled" && status !== "completed" && "text-foreground/90",
                )}
              >
                {asString(item.text) ?? ""}
              </span>
            </li>
          );
        })}
      </ul>
      {notice !== undefined && (
        <p className="text-caution text-[10px] leading-relaxed">{notice}</p>
      )}
    </div>
  );
}

function modeDetail({ envelope }: ToolDetailProps) {
  if (!envelope?.ok) return null;
  const mode = asString(asRecord(envelope.value).mode);
  return mode !== undefined ? (
    <ToolKeyValues rows={[{ key: "target mode", value: mode, mono: true }]} />
  ) : null;
}

export const runtimeViews = {
  run_js: {
    icon: Braces,
    label: () => "Ran JavaScript",
    meta: (_args, envelope) => {
      if (!envelope) return undefined;
      const value = asRecord(envelope.value);
      const stdout = asString(value.stdout) ?? "";
      return stdout.length > 0 ? `${stdout.split("\n").length} lines out` : undefined;
    },
    Detail: runDetail,
  },
  run_python: {
    icon: Terminal,
    label: () => "Ran Python",
    meta: (_args, envelope) => {
      if (!envelope) return undefined;
      const value = asRecord(envelope.value);
      const stdout = asString(value.stdout) ?? "";
      return stdout.length > 0 ? `${stdout.split("\n").length} lines out` : undefined;
    },
    Detail: runDetail,
  },
  reset_sandbox: {
    icon: RefreshCcw,
    label: () => "Reset sandbox",
    meta: (_args, envelope) => {
      if (!envelope?.ok) return undefined;
      const reset = asArray(asRecord(envelope.value).reset).filter(
        (item): item is string => typeof item === "string",
      );
      return reset.length > 0 ? reset.join(", ") : undefined;
    },
    Detail: ({ envelope }) => {
      if (!envelope?.ok) return null;
      const reset = asArray(asRecord(envelope.value).reset).filter(
        (item): item is string => typeof item === "string",
      );
      return (
        <p className="text-muted text-xs">
          Restarted {reset.length > 0 ? reset.join(" and ") : "both runtimes"}.
          Workspace files are untouched.
        </p>
      );
    },
  },
  update_plan: {
    icon: ListChecks,
    label: () => "Updated the plan",
    meta: (_args, envelope) => {
      if (!envelope?.ok) return undefined;
      const counts = asRecord(asRecord(envelope.value).counts);
      const completed = asNumber(counts.completed) ?? 0;
      const total = asArray(asRecord(envelope.value).items).length;
      return total > 0 ? `${completed}/${total} done` : undefined;
    },
    Detail: planDetail,
  },
  change_mode: {
    icon: ShieldHalf,
    label: (args) => `Requested ${asString(args.mode) ?? "a"} mode`,
    meta: (_args, envelope) =>
      envelope?.ok ? asString(asRecord(envelope.value).mode) : undefined,
    Detail: modeDetail,
  },
} satisfies Record<string, ToolViewSpec>;
