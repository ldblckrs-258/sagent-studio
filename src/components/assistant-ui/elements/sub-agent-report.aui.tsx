import { Bot, TriangleAlert } from "lucide-react";
import type { AgentNoticeMeta, AgentRunStatus } from "@/chat/types";
import { Badge, type BadgeTone } from "@/ui/primitives";

/**
 * How a settled run's status reads on the report card. Tone carries the outcome
 * the way the rest of the app does: completed is calm, a partial or refused run
 * is a caution, a hard failure is danger.
 */
const STATUS_TONE: Record<AgentRunStatus, { label: string; tone: BadgeTone }> = {
  running: { label: "Running", tone: "accent" },
  completed: { label: "Completed", tone: "positive" },
  denied: { label: "Denied", tone: "caution" },
  aborted: { label: "Aborted", tone: "neutral" },
  interrupted: { label: "Interrupted", tone: "caution" },
  error: { label: "Failed", tone: "danger" },
  limit_exceeded: { label: "Limit reached", tone: "danger" },
  invalid_input: { label: "Invalid request", tone: "danger" },
};

/**
 * The transcript card for a background sub-agent: its identity, its outcome,
 * and the text it returned. A background run settles long after its
 * `spawn_agent` call did, so the result is delivered as a notice message rather
 * than a tool result; this is that notice's display form. The card replaces the
 * assistant bubble, which matters because a bubble would offer Regenerate and
 * regenerating a notice would drop the report.
 *
 * The response is untrusted model output. The card says so rather than implying
 * the text is an instruction.
 */
export function SubAgentReport({ report }: { report: AgentNoticeMeta }) {
  const spec = STATUS_TONE[report.status] ?? STATUS_TONE.completed;
  return (
    <div
      data-slot="aui_sub-agent-report"
      className="border-rule bg-surface mx-2 my-1.5 flex flex-col gap-2 rounded-sm border px-2.5 py-2"
    >
      <div className="flex items-center gap-2">
        <span
          className="border-accent-rule bg-accent-soft text-accent inline-flex size-5 shrink-0 items-center justify-center rounded-sm border"
          aria-hidden="true"
        >
          <Bot className="size-3" strokeWidth={1.75} />
        </span>
        <span className="text-ink min-w-0 flex-1 truncate text-xs font-medium">
          {report.label !== undefined && report.label.length > 0
            ? `Sub-agent: ${report.label}`
            : "Sub-agent report"}
        </span>
        <Badge tone={spec.tone}>{spec.label}</Badge>
      </div>

      <div className="flex items-center gap-2" role="separator" aria-label="Response">
        <span className="bg-rule h-px flex-1" aria-hidden="true" />
        <span className="label-micro">Response</span>
        <span className="bg-rule h-px flex-1" aria-hidden="true" />
      </div>

      <p className="text-foreground/90 text-xs leading-relaxed whitespace-pre-wrap">
        {report.response}
      </p>

      <div className="text-faint flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px]">
        <span className="flex items-center gap-1">
          <TriangleAlert className="size-2.5 shrink-0" aria-hidden="true" />
          untrusted output
        </span>
        {report.runId !== undefined && report.runId.length > 0 && (
          <span className="ml-auto shrink-0 truncate font-mono">run {report.runId}</span>
        )}
      </div>
    </div>
  );
}
