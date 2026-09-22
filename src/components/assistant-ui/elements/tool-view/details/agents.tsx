import {
  ArrowDownLeft,
  Bot,
  Loader,
  Radio,
  TriangleAlert,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { MODEL_TIER_META, tierForMode } from "@/ai/model-tier";
import type { ChatMode } from "@/chat/types";
import { cn } from "@/lib/utils";
import type { ModelTier } from "@/vault/settings";
import {
  ToolChip,
  ToolSection,
  type ChipTone,
  type ToolDetailProps,
  type ToolViewSpec,
} from "../primitives";
import { asArray, asNumber, asRecord, asString, pluralize } from "../helpers";

const TIERS: readonly ModelTier[] = ["cheap", "medium", "high", "max"];
const MODES: readonly ChatMode[] = ["read_only", "editing", "god"];

/**
 * One hue per tier, drawn from the workspace file-kind ramp so four choices read
 * as a single family. Oracle lands on the brand accent because it is the tier a
 * user reserves for deliberate advisory work.
 *
 * The three file hues are mixed 80% toward ink for the label: at their raw
 * lightness they sit at ~3.4:1 on paper, under the 4.5:1 floor for text. The
 * mix keeps the hue while clearing it, and because it is built from the theme
 * variables it follows both light and dark mode.
 */
const TIER_CHIP: Record<ModelTier, string> = {
  cheap: "border-file-data/40 bg-file-data/10 text-tier-spark",
  medium: "border-file-code/40 bg-file-code/10 text-tier-forge",
  high: "border-file-media/40 bg-file-media/10 text-tier-prime",
  max: "border-accent-rule bg-accent-soft text-accent",
};

/** A mode's restraint reads as its color: safe is calm, unrestricted is danger. */
const MODE_CHIP: Record<ChatMode, { tone: ChipTone; label: string }> = {
  read_only: { tone: "positive", label: "Read only" },
  editing: { tone: "caution", label: "Editing" },
  god: { tone: "danger", label: "God" },
};

function readMode(args: Record<string, unknown>): ChatMode {
  const mode = asString(args.mode);
  return (MODES as readonly string[]).includes(mode ?? "") ? (mode as ChatMode) : "read_only";
}

function readTier(args: Record<string, unknown>): ModelTier {
  const tier = asString(args.tier);
  if ((TIERS as readonly string[]).includes(tier ?? "")) return tier as ModelTier;
  return tierForMode(readMode(args));
}

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

function TierChip({ tier }: { tier: ModelTier }) {
  return (
    <span
      data-slot="agent-tier-chip"
      title={`${MODEL_TIER_META[tier].label} tier`}
      className={cn(
        "inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[10px] leading-none",
        TIER_CHIP[tier],
      )}
    >
      {MODEL_TIER_META[tier].label}
    </span>
  );
}

function ModeChip({ mode }: { mode: ChatMode }) {
  const spec = MODE_CHIP[mode];
  return <ToolChip tone={spec.tone}>{spec.label}</ToolChip>;
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
          <p className="text-foreground/90 text-xs leading-relaxed whitespace-pre-wrap">
            {response.length > 0 ? response : "The agent returned no text."}
          </p>
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
              Progress and approval requests appear in the Agents panel. A notice lands here
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
    Detail: DelegationDetail,
  },
} satisfies Record<string, ToolViewSpec>;
