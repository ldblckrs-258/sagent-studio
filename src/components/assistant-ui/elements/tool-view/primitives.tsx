import { Fragment, type FC, type ReactNode } from "react";
import {
  AlertCircleIcon,
  ChevronDownIcon,
  LoaderIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { ToolFallbackDuration } from "@/components/assistant-ui/elements/tool-fallback.aui";
import { cn } from "@/lib/utils";
import {
  capLines,
  humanizeCode,
  humanizeKey,
  safeJson,
  type ToolEnvelope,
} from "./helpers";

export interface ToolDetailProps {
  args: Record<string, unknown>;
  envelope: ToolEnvelope | null;
  status?: { type: string; reason?: string } | undefined;
}

export interface ToolViewSpec {
  icon: LucideIcon;
  /** Header text with the target folded in, e.g. "Read notes.md". */
  label: (args: Record<string, unknown>, envelope: ToolEnvelope | null) => string;
  /** Short right-aligned summary, e.g. "128 lines" or "3 hits". */
  meta?: (args: Record<string, unknown>, envelope: ToolEnvelope | null) => string | undefined;
  /**
   * When true the body opens itself, for a view the user should see at a glance
   * (a file preview) rather than one they must expand. A failure or a pending
   * decision always opens regardless.
   */
  autoOpen?: (args: Record<string, unknown>, envelope: ToolEnvelope | null) => boolean;
  /** Structured body. Falls back to `GenericDetail` when omitted. */
  Detail?: FC<ToolDetailProps>;
}

const CHIP_TONES = {
  neutral: "border-rule bg-paper-sunk text-muted",
  accent: "border-accent-rule bg-accent-soft text-accent",
  positive: "border-rule bg-paper-sunk text-positive",
  caution: "border-caution-rule bg-caution-soft text-caution",
  danger: "border-danger-rule bg-danger-soft text-danger",
} as const;

export type ChipTone = keyof typeof CHIP_TONES;

export function ToolChip({
  tone = "neutral",
  children,
}: {
  tone?: ChipTone;
  children: ReactNode;
}) {
  return (
    <span
      data-slot="tool-chip"
      className={cn(
        "inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[10px] leading-none",
        CHIP_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

/**
 * A labelled block inside an expanded tool call. The label is a functional
 * heading, not decoration: it separates arguments from output from diagnostics.
 */
export function ToolSection({
  label,
  count,
  children,
}: {
  label?: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      {label !== undefined && (
        <h4 className="label-micro flex items-baseline gap-1.5">
          <span>{label}</span>
          {count !== undefined && (
            <span className="numeric font-mono">{count}</span>
          )}
        </h4>
      )}
      {children}
    </section>
  );
}

/** A mono block for code, file contents, diffs, and console output. */
export function ToolCode({
  text,
  limit = 400,
  className,
}: {
  text: string;
  limit?: number;
  className?: string;
}) {
  const { text: shown, hidden } = capLines(text, limit);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <pre
        data-slot="tool-code"
        className={cn(
          "max-h-64 overflow-auto rounded-sm border border-rule bg-paper-sunk/50 p-2 font-mono text-xs leading-relaxed whitespace-pre text-foreground/90",
          className,
        )}
      >
        {shown.length > 0 ? shown : "\u00a0"}
      </pre>
      {hidden > 0 && (
        <p className="text-faint text-[10px]">
          {hidden} more {hidden === 1 ? "line" : "lines"} not shown
        </p>
      )}
    </div>
  );
}

export interface ToolKeyValueRow {
  key: string;
  value: ReactNode;
  mono?: boolean;
}

export function ToolKeyValues({ rows }: { rows: ToolKeyValueRow[] }) {
  if (rows.length === 0) return null;
  return (
    <dl className="grid grid-cols-[minmax(5rem,auto)_1fr] items-baseline gap-x-3 gap-y-1 text-xs">
      {rows.map((row) => (
        <Fragment key={row.key}>
          <dt className="text-faint">{row.key}</dt>
          <dd
            className={cn(
              "min-w-0 leading-relaxed break-words text-foreground/90",
              row.mono && "font-mono",
            )}
          >
            {row.value}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/**
 * Renders an arbitrary JSON value without falling back to a raw dump. Objects
 * become definition lists, primitive arrays become chips, and strings that read
 * as prose stay prose. Depth is bounded, past which a compact block is safer
 * than an unbounded recursion.
 */
export function ValueView({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined) {
    return <span className="text-faint">none</span>;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return <span className="numeric font-mono text-foreground">{String(value)}</span>;
  }
  if (typeof value === "string") {
    if (value.length === 0) return <span className="text-faint">empty</span>;
    if (value.includes("\n") || value.length > 160) return <ToolCode text={value} />;
    return <span className="text-foreground">{value}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-faint">empty list</span>;
    const allPrimitive = value.every(
      (item) => item === null || typeof item !== "object",
    );
    if (allPrimitive) {
      return (
        <div className="flex flex-wrap gap-1">
          {value.map((item, index) => (
            <ToolChip key={`${index}:${String(item)}`}>{String(item)}</ToolChip>
          ))}
        </div>
      );
    }
    return (
      <ul className="flex flex-col gap-1.5">
        {value.map((item, index) => (
          <li
            key={index}
            className="min-w-0 rounded-sm border border-rule/70 bg-paper-sunk/30 px-2 py-1.5"
          >
            <ValueView value={item} depth={depth + 1} />
          </li>
        ))}
      </ul>
    );
  }
  if (depth >= 4) return <ToolCode text={safeJson(value)} limit={80} />;

  const record = value as Record<string, unknown>;
  // A user's http tool returns a response shape; render it as a response rather
  // than an opaque object with three keys.
  if (typeof record.status === "number" && typeof record.body === "string") {
    return <HttpResponseView record={record} />;
  }
  const entries = Object.entries(record);
  if (entries.length === 0) return <span className="text-faint">empty</span>;
  return (
    <ToolKeyValues
      rows={entries.map(([key, item]) => ({
        key: humanizeKey(key),
        value: <ValueView value={item} depth={depth + 1} />,
      }))}
    />
  );
}

function HttpResponseView({ record }: { record: Record<string, unknown> }) {
  const status = record.status as number;
  const body = record.body as string;
  const tone: ChipTone = status >= 200 && status < 300 ? "positive" : "danger";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <ToolChip tone={tone}>HTTP {status}</ToolChip>
        {typeof record.contentType === "string" && record.contentType.length > 0 && (
          <span className="text-faint truncate font-mono text-[10px]">
            {record.contentType}
          </span>
        )}
      </div>
      {body.length > 0 && <ToolCode text={body} limit={120} />}
    </div>
  );
}

/** The default body for a tool with no tailored view: arguments and result, structured. */
export const GenericDetail: FC<ToolDetailProps> = ({ args, envelope }) => {
  const argEntries = Object.entries(args).filter(([, value]) => value !== undefined);
  const value = envelope?.value;
  return (
    <div className="flex flex-col gap-3">
      {argEntries.length > 0 && (
        <ToolSection label="Arguments">
          <ValueView value={Object.fromEntries(argEntries)} depth={1} />
        </ToolSection>
      )}
      {value !== undefined && (
        <ToolSection label="Result">
          <ValueView value={value} depth={1} />
        </ToolSection>
      )}
    </div>
  );
};

/**
 * Failure surface for one tool call. It reads both error channels: the
 * `incomplete` status the runtime sets for a transport/execution error, and a
 * `ToolResult` envelope carrying `ok: false`.
 */
export function ToolFailure({
  envelope,
  status,
}: {
  envelope: ToolEnvelope | null;
  status?: { type: string; reason?: string; error?: unknown } | undefined;
}) {
  const cancelled = status?.type === "incomplete" && status.reason === "cancelled";
  if (cancelled) {
    return <p className="text-muted text-xs">Cancelled before it finished.</p>;
  }
  if (envelope && envelope.ok === false) {
    return (
      <div
        data-slot="tool-failure"
        role="status"
        className="border-danger-rule bg-danger-soft flex flex-col gap-1 rounded-sm border px-2 py-1.5 text-xs"
      >
        <span className="text-danger flex items-center gap-1.5 font-medium">
          <span className="font-mono">{humanizeCode(envelope.code)}</span>
        </span>
        {envelope.message && (
          <span className="leading-relaxed text-danger">{envelope.message}</span>
        )}
        {envelope.hint && (
          <span className="leading-relaxed text-danger/80">{envelope.hint}</span>
        )}
      </div>
    );
  }
  if (
    status !== undefined &&
    status.type === "incomplete" &&
    status.error !== undefined &&
    status.error !== null
  ) {
    return (
      <div
        role="status"
        className="border-danger-rule bg-danger-soft text-danger rounded-sm border px-2 py-1.5 font-mono text-xs"
      >
        {safeJson(status.error)}
      </div>
    );
  }
  return null;
}

/**
 * The disclosure header. It carries the state in one glyph: the domain icon at
 * rest, a spinner while running, an alert on failure. That keeps the row
 * scannable without a second icon competing for attention.
 */
export function ToolViewTrigger({
  icon: DomainIcon,
  label,
  meta,
  status,
}: {
  icon: LucideIcon;
  label: string;
  meta?: string | undefined;
  status?: { type: string; reason?: string } | undefined;
}) {
  const statusType = status?.type ?? "complete";
  const isRunning = statusType === "running";
  const isCancelled =
    status !== undefined && status.type === "incomplete" && status.reason === "cancelled";
  const isFailed = statusType === "incomplete" && !isCancelled;
  const isRequiresAction = statusType === "requires-action";

  const Icon = isRunning
    ? LoaderIcon
    : isFailed
      ? XCircleIcon
      : isRequiresAction
        ? AlertCircleIcon
        : DomainIcon;

  return (
    <CollapsibleTrigger
      data-slot="tool-view-trigger"
      title={label}
      className={cn(
        "group/trigger text-muted-foreground hover:text-foreground flex w-full min-w-0 origin-left items-center gap-2 py-1.5 text-sm transition-[color,scale] active:scale-[0.98]",
      )}
    >
      <Icon
        data-slot="tool-view-icon"
        className={cn(
          "size-3.5 shrink-0",
          isRequiresAction && "text-caution",
          isFailed && "text-danger",
          isRunning && "animate-spin [animation-duration:0.6s]",
        )}
        aria-hidden="true"
      />
      <span
        data-slot="tool-view-label"
        className={cn(
          "min-w-0 flex-1 truncate text-start leading-none",
          isCancelled && "text-muted line-through",
          isRunning && "shimmer motion-reduce:animate-none",
        )}
      >
        {label}
      </span>
      {meta !== undefined && meta.length > 0 && (
        <span
          data-slot="tool-view-meta"
          className="text-faint numeric ms-auto shrink-0 font-mono text-[10px]"
        >
          {meta}
        </span>
      )}
      <ToolFallbackDuration
        className={meta !== undefined && meta.length > 0 ? "ms-1" : "ms-auto"}
      />
      <ChevronDownIcon
        data-slot="tool-view-chevron"
        className={cn(
          "size-3.5 shrink-0 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
          "-rotate-90 group-data-open/trigger:rotate-0 group-data-panel-open/trigger:rotate-0",
        )}
        aria-hidden="true"
      />
    </CollapsibleTrigger>
  );
}
