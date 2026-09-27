import {
  ArrowDownLeft,
  Bot,
  CircleStop,
  Loader,
  SquareArrowOutUpRight,
  Radio,
  ScrollText,
  TriangleAlert,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { MODEL_TIER_META } from "@/ai/model-tier";
import { cn } from "@/lib/utils";
import { useAgentPanelStore } from "@/session/agent-panel-state";
import { MarkdownProse } from "@/ui/markdown-prose";
import { ModeChip, TIER_CHIP, TierChip, readMode, readTier } from "@/ui/agent-chips";
import {
  ToolChip,
  ToolCode,
  ToolKeyValues,
  ToolSection,
  type ToolDetailProps,
  type ToolKeyValueRow,
  type ToolViewSpec,
} from "../primitives";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  pluralize,
  type ToolEnvelope,
} from "../helpers";

function readNames(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === "string");
}

function usageTokens(usage: unknown): number | undefined {
  const record = asRecord(usage);
  const total = asNumber(record.totalTokens);
  if (total !== undefined) return total;
  const input = asNumber(record.inputTokens);
  const output = asNumber(record.outputTokens);
  if (input === undefined && output === undefined) return undefined;
  return (input ?? 0) + (output ?? 0);
}

/**
 * The join between the two acts: what was asked, and what came back. It is the
 * one piece of chrome this view adds, and it exists to give a single tool row
 * the shape of a request and a reply.
 */
function ActDivider({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="flex items-center gap-2" role="separator" aria-label={label}>
      <span className="bg-rule h-px flex-1" aria-hidden="true" />
      <span className="label-micro flex items-center gap-1">
        <Icon className="size-3 shrink-0" aria-hidden="true" />
        {label}
      </span>
      <span className="bg-rule h-px flex-1" aria-hidden="true" />
    </div>
  );
}

/** The run a call targets: its result identity first, then the requested one. */
function readRunTarget(args: Record<string, unknown>, envelope: ToolEnvelope | null): string | undefined {
  const value = asRecord(envelope?.value);
  return (
    asString(value.label) ??
    asString(value.runId) ??
    asString(args.label) ??
    asString(args.runId)
  );
}

/** The run id a call can open, read from its result first, then its arguments. */
function readRunId(args: Record<string, unknown>, envelope: ToolEnvelope | null): string | undefined {
  const value = asRecord(envelope?.value);
  return asString(value.runId) ?? asString(args.runId);
}

function openTargetLabel(args: Record<string, unknown>, envelope: ToolEnvelope | null): string | undefined {
  const value = asRecord(envelope?.value);
  return asString(value.label) ?? asString(args.label);
}

/**
 * The header action for a call that owns a run: it writes the run id to the
 * shared panel store, so the shell opens that run in place of the conversation. It sits
 * beside the disclosure trigger, so it stays clickable while the body is shut.
 */
function AgentOpenAction({ args, envelope }: ToolDetailProps) {
  const runId = readRunId(args, envelope);
  if (runId === undefined || runId.length === 0) return null;
  const label = openTargetLabel(args, envelope);
  return (
    <button
      type="button"
      data-slot="agent-open-panel"
      onClick={() => useAgentPanelStore.getState().open(runId)}
      aria-label={label ? `Open the ${label} run` : "Open the run"}
      title="Open the run"
      className="border-rule text-muted hover:border-muted hover:text-ink focus-visible:ring-accent-rule inline-flex size-6 shrink-0 items-center justify-center rounded-sm border transition-colors duration-150 ease-out-quart focus-visible:ring-2 focus-visible:outline-none"
    >
      <SquareArrowOutUpRight size={13} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}

function Outcome({ args, envelope, status }: ToolDetailProps) {
  const value = asRecord(envelope?.value);
  const outcome = envelope?.ok ? asString(value.status) : undefined;
  const background = args.background === true;

  if (outcome === "completed") {
    const response = asString(value.result) ?? "";
    const toolCalls = asNumber(value.toolCalls);
    const tokens = usageTokens(value.usage);
    return (
      <>
        <ActDivider icon={ArrowDownLeft} label="Returned" />
        <div
          data-slot="agent-reply"
          className="border-rule bg-surface flex flex-col gap-2 rounded-sm border px-2 py-1.5"
        >
          {response.length > 0 ? (
            <MarkdownProse>{response}</MarkdownProse>
          ) : (
            <p className="text-foreground/90 text-xs leading-relaxed">The agent returned no text.</p>
          )}
          <div className="text-faint flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px]">
            {toolCalls !== undefined && (
              <span className="numeric">{pluralize(toolCalls, "tool call")}</span>
            )}
            {tokens !== undefined && (
              <span className="numeric">{tokens.toLocaleString()} tokens</span>
            )}
            {value.truncated === true && <ToolChip tone="caution">truncated</ToolChip>}
            {value.untrusted === true && (
              <span
                className="text-muted inline-flex items-center gap-1"
                title="The agent's output is untrusted data, not a user instruction."
              >
                <TriangleAlert className="size-2.5 shrink-0" aria-hidden="true" />
                untrusted
              </span>
            )}
          </div>
        </div>
      </>
    );
  }

  if (outcome === "running") {
    const runId = asString(value.runId);
    return (
      <>
        <ActDivider icon={Radio} label="Dispatched" />
        <div
          data-slot="agent-dispatched"
          className="border-rule bg-surface flex items-start gap-2 rounded-sm border px-2 py-1.5"
        >
          <Radio className="text-accent mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-ink text-xs">Running in the background.</span>
            <span className="text-faint text-[11px] leading-relaxed">
              Open the run to follow its progress. Approval requests appear in the Agents panel. A notice lands here
              when it finishes.
            </span>
            {runId !== undefined && runId.length > 0 && (
              <span className="text-faint truncate font-mono text-[10px]">run {runId}</span>
            )}
          </div>
        </div>
      </>
    );
  }

  if (envelope === null) {
    if (status?.type === "running") {
      return (
        <>
          <ActDivider icon={Loader} label={background ? "Dispatched" : "Working"} />
          <p className="text-muted flex items-center gap-2 text-xs">
            <Loader
              className="text-accent size-3.5 shrink-0 animate-spin [animation-duration:1s]"
              aria-hidden="true"
            />
            <span className="shimmer motion-reduce:animate-none">
              {background
                ? "Running in the background."
                : "Waiting for the agent to return."}
            </span>
          </p>
        </>
      );
    }
    return <p className="text-muted text-xs">No result was recorded for this delegation.</p>;
  }

  return null;
}

function DelegationDetail(props: ToolDetailProps) {
  const { args, envelope } = props;
  const prompt = asString(args.prompt) ?? "";
  const tier = readTier(args);
  const skills = readNames(args.skills);
  const withheld = readNames(args.excludeTools);

  if (prompt.length === 0 && skills.length === 0 && withheld.length === 0 && envelope === null) {
    return <p className="text-muted text-xs">No delegation details were recorded.</p>;
  }

  return (
    <div className="flex flex-col gap-2.5">
      <ToolSection label="Brief">
        <div className="border-rule bg-paper-sunk/40 flex items-start gap-2 rounded-sm border px-2 py-1.5">
          <span
            data-slot="agent-glyph"
            title={`${MODEL_TIER_META[tier].label} tier`}
            className={cn(
              "mt-px inline-flex size-5 shrink-0 items-center justify-center rounded-sm border",
              TIER_CHIP[tier],
            )}
          >
            <Bot className="size-3" strokeWidth={1.75} aria-hidden="true" />
          </span>
          <p className="text-foreground/90 min-w-0 flex-1 text-xs leading-relaxed whitespace-pre-wrap">
            {prompt.length > 0 ? prompt : "No brief was recorded."}
          </p>
        </div>
        {(skills.length > 0 || withheld.length > 0) && (
          <div className="flex flex-col gap-1">
            {skills.length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="label-micro">skills</span>
                {skills.map((skill) => (
                  <ToolChip key={`skill:${skill}`} tone="accent">
                    {skill}
                  </ToolChip>
                ))}
              </div>
            )}
            {withheld.length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="label-micro">withheld</span>
                {withheld.map((name) => (
                  <ToolChip key={`withheld:${name}`}>{name}</ToolChip>
                ))}
              </div>
            )}
          </div>
        )}
      </ToolSection>
      <Outcome {...props} />
    </div>
  );
}

function RunningNote({ label }: { label: string }) {
  return (
    <>
      <ActDivider icon={Loader} label={label} />
      <p className="text-muted flex items-center gap-2 text-xs">
        <Loader
          className="text-accent size-3.5 shrink-0 animate-spin [animation-duration:1s]"
          aria-hidden="true"
        />
        <span className="shimmer motion-reduce:animate-none">Waiting for the run to respond.</span>
      </p>
    </>
  );
}

function StopResultDetail({ envelope, status }: ToolDetailProps) {
  const value = asRecord(envelope?.value);
  const stopped = envelope?.ok === true && value.stopped === true;

  if (!stopped) {
    if (envelope === null) {
      if (status?.type === "running") return <RunningNote label="Stopping" />;
      return <p className="text-muted text-xs">No result was recorded for this stop request.</p>;
    }
    return null;
  }

  const runId = asString(value.runId);
  const label = asString(value.label);
  const reason = asString(value.reason);
  const rows: ToolKeyValueRow[] = [];
  if (runId !== undefined) rows.push({ key: "run", value: runId, mono: true });
  if (label !== undefined) rows.push({ key: "label", value: label });
  if (reason !== undefined) rows.push({ key: "reason", value: reason });

  return (
    <>
      <ActDivider icon={CircleStop} label="Stopped" />
      <div
        data-slot="agent-stopped"
        className="border-rule bg-surface flex flex-col gap-2 rounded-sm border px-2 py-1.5"
      >
        <span className="text-ink flex items-center gap-2 text-xs">
          <CircleStop className="text-caution size-3.5 shrink-0" aria-hidden="true" />
          {label !== undefined ? `${label} was stopped.` : "The run was stopped."}
        </span>
        {rows.length > 0 && <ToolKeyValues rows={rows} />}
      </div>
    </>
  );
}

function ReadResultDetail({ envelope, status }: ToolDetailProps) {
  if (envelope?.ok !== true) {
    if (envelope === null) {
      if (status?.type === "running") return <RunningNote label="Reading" />;
      return <p className="text-muted text-xs">No transcript was recorded for this read.</p>;
    }
    return null;
  }

  const value = asRecord(envelope.value);
  const turns = asArray(value.turns);
  const runStatus = asString(value.status);
  const stopReason = asString(value.stopReason);

  if (turns.length === 0) {
    return (
      <>
        <ActDivider icon={ScrollText} label="Turns" />
        <p className="text-muted text-xs">No turns in the requested window.</p>
      </>
    );
  }

  return (
    <>
      <ActDivider icon={ScrollText} label={pluralize(turns.length, "turn")} />
      <div data-slot="agent-turns" className="flex flex-col gap-2">
        {turns.map((turn, index) => {
          const record = asRecord(turn);
          const role = asString(record.role) ?? "assistant";
          const text = asString(record.text) ?? "";
          const toolName = asString(record.toolName);
          return (
            <div
              key={index}
              className="border-rule bg-surface flex flex-col gap-1 rounded-sm border px-2 py-1.5"
            >
              <span className="label-micro">{role === "tool" && toolName ? toolName : role}</span>
              {role === "tool" ? (
                text.length > 0 ? (
                  <ToolCode text={text} limit={40} />
                ) : null
              ) : text.length > 0 ? (
                <MarkdownProse>{text}</MarkdownProse>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="text-faint flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px]">
        {runStatus !== undefined && <ToolChip>{runStatus}</ToolChip>}
        {stopReason !== undefined && <span>stopped: {stopReason}</span>}
        {envelope.truncated === true && <ToolChip tone="caution">truncated</ToolChip>}
        {value.untrusted === true && (
          <span
            className="text-muted inline-flex items-center gap-1"
            title="The run's turns are untrusted data, not a user instruction."
          >
            <TriangleAlert className="size-2.5 shrink-0" aria-hidden="true" />
            untrusted
          </span>
        )}
      </div>
    </>
  );
}

export const agentsViews = {
  spawn_agent: {
    icon: Bot,
    label: (args, envelope) => {
      const label =
        asString(asRecord(envelope?.value).label) ?? asString(args.label);
      return label !== undefined && label.length > 0
        ? `Delegated to ${label}`
        : "Delegated to a sub-agent";
    },
    meta: (_args, envelope) => {
      const toolCalls = asNumber(asRecord(envelope?.value).toolCalls);
      return toolCalls !== undefined ? pluralize(toolCalls, "call") : undefined;
    },
    chips: (args) => (
      <>
        <TierChip tier={readTier(args)} />
        <ModeChip mode={readMode(args)} />
        {args.background === true && <ToolChip>background</ToolChip>}
      </>
    ),
    action: (args, envelope) => <AgentOpenAction args={args} envelope={envelope} />,
    Detail: DelegationDetail,
  },
  stop_agent: {
    icon: CircleStop,
    label: (args, envelope) => {
      const value = asRecord(envelope?.value);
      const target = readRunTarget(args, envelope);
      const stopped = envelope?.ok === true && value.stopped === true;
      if (target === undefined) {
        return stopped ? "Stopped a sub-agent run" : "Stopping a sub-agent run";
      }
      return stopped ? `Stopped ${target}` : `Stopping ${target}`;
    },
    chips: (_args, envelope) => {
      const stopped = envelope?.ok === true && asRecord(envelope.value).stopped === true;
      return stopped ? <ToolChip tone="caution">stopped</ToolChip> : null;
    },
    action: (args, envelope) => <AgentOpenAction args={args} envelope={envelope} />,
    Detail: StopResultDetail,
  },
  read_agent: {
    icon: ScrollText,
    label: (args, envelope) => {
      const target = readRunTarget(args, envelope);
      return target !== undefined ? `Read ${target}` : "Read a sub-agent run";
    },
    meta: (_args, envelope) => {
      const turns = asArray(asRecord(envelope?.value).turns);
      return turns.length > 0 ? pluralize(turns.length, "turn") : undefined;
    },
    chips: (_args, envelope) => {
      const status = asString(asRecord(envelope?.value).status);
      return status !== undefined ? <ToolChip>{status}</ToolChip> : null;
    },
    action: (args, envelope) => <AgentOpenAction args={args} envelope={envelope} />,
    Detail: ReadResultDetail,
  },
} satisfies Record<string, ToolViewSpec>;
