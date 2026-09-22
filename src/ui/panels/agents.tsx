"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { MODEL_TIER_META } from "../../ai/model-tier";
import type { AgentRunRecord } from "../../agents/store";
import { agentRunStore } from "../../agents/store";
import { listAgentRuns } from "../../chat/persistence";
import { useChatStore } from "../../chat/store";
import type { ChatThread } from "../../chat/types";
import { useSession } from "../../session/session-context";
import { AgentApprovalCard } from "../agent-approval";
import { useRegistryVersion } from "../use-registry-version";
import { Button } from "../primitives";

const STATUS_TINT: Record<string, string> = {
  running: "text-accent",
  completed: "text-positive",
  interrupted: "text-caution",
  denied: "text-caution",
  aborted: "text-muted",
  error: "text-danger",
  limit_exceeded: "text-danger",
  invalid_input: "text-danger",
};

function modeLabel(mode: string): string {
  if (mode === "read_only") return "Read only";
  if (mode === "god") return "God";
  return "Editing";
}

function tierLabel(tier: string): string {
  return MODEL_TIER_META[tier as keyof typeof MODEL_TIER_META]?.label ?? tier;
}

function elapsed(startedAt: number, endedAt: number | undefined, now: number): string {
  const seconds = Math.max(0, Math.round(((endedAt ?? now) - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/** The streamed transcript of a live run: its text and the tools it called. */
function liveTranscript(run: AgentRunRecord): string {
  return run.events
    .map((event) => {
      if (event.type === "text-delta") return event.text;
      if (event.type === "tool-call") return `\n[called ${event.toolName}]\n`;
      if (event.type === "tool-error") return `\n[tool ${event.toolName} failed: ${event.error}]\n`;
      return "";
    })
    .join("");
}

function persistedTranscript(thread: ChatThread): string {
  return thread.messages
    .map((message) =>
      message.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join(""),
    )
    .join("\n")
    .trim();
}

export function RunRow({
  title,
  tier,
  mode,
  status,
  elapsedText,
  transcript,
  expanded,
  onToggle,
  onCancel,
}: {
  title: string;
  tier: string;
  mode: string;
  status: string;
  elapsedText: string;
  transcript: string;
  expanded: boolean;
  onToggle(): void;
  onCancel?: () => void;
}) {
  const running = status === "running";
  return (
    <div className="border-rule border-b px-1.5 py-1.5">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {expanded ? (
            <ChevronDown size={13} strokeWidth={1.75} className="shrink-0 text-faint" />
          ) : (
            <ChevronRight size={13} strokeWidth={1.75} className="shrink-0 text-faint" />
          )}
          <span className="min-w-0 flex-1 truncate text-xs text-ink">{title}</span>
        </button>
        {running && onCancel ? (
          <Button size="sm" variant="quiet" onClick={onCancel} aria-label="Cancel agent run">
            Cancel
          </Button>
        ) : null}
      </div>
      <div className="mt-1 flex items-center gap-2 pl-[19px] text-[11px]">
        <span className={STATUS_TINT[status] ?? "text-muted"}>{status}</span>
        <span className="text-faint">·</span>
        <span className="text-faint">{modeLabel(mode)}</span>
        <span className="text-faint">·</span>
        <span className="text-faint">{tierLabel(tier)}</span>
        <span className="text-faint">·</span>
        <span className="numeric text-faint">{elapsedText}</span>
      </div>
      {expanded ? (
        <pre className="border-rule bg-paper-sunk text-muted mt-1.5 max-h-64 overflow-auto rounded-sm border px-2 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {transcript.trim() || "(no output yet)"}
        </pre>
      ) : null}
    </div>
  );
}

/**
 * Live and persisted delegated runs for the active conversation. Persisted child
 * threads load first; a live run overlays its entry while it streams. Queued
 * approvals render at the top so a paused agent is impossible to miss.
 */
export function AgentsPanel() {
  const session = useSession();
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  useRegistryVersion(agentRunStore);
  const [persisted, setPersisted] = useState<ChatThread[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const live = agentRunStore.list(activeThreadId ?? undefined);
  const liveIds = new Set(live.map((run) => run.runId));
  const settledSignature = live
    .filter((run) => run.status !== "running")
    .map((run) => `${run.runId}:${run.status}`)
    .join(",");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const runs = await listAgentRuns(activeThreadId ?? undefined);
      if (!cancelled) setPersisted(runs);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeThreadId, settledSignature]);

  const anyRunning = live.some((run) => run.status === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyRunning]);

  const approvals = agentRunStore.pendingApprovals(activeThreadId ?? undefined);
  const approvalsWithLabel = useMemo(
    () =>
      approvals.map((approval) => ({
        approval,
        label: live.find((run) => run.runId === approval.runId)?.label,
      })),
    [approvals, live],
  );

  return (
    <div className="flex flex-col py-1">
      {approvalsWithLabel.map(({ approval, label }) => (
        <AgentApprovalCard key={approval.id} approval={approval} {...(label ? { label } : {})} />
      ))}

      {live.length === 0 && persisted.length === 0 ? (
        <p className="px-3 py-3 text-xs leading-relaxed text-muted">
          No delegated agents yet. The model can call <span className="font-mono">spawn_agent</span>{" "}
          to hand a bounded task to a sub-agent.
        </p>
      ) : null}

      {live.map((run) => (
        <RunRow
          key={run.runId}
          title={run.label || run.prompt.slice(0, 60) || "Agent run"}
          tier={run.tier}
          mode={run.mode}
          status={run.status}
          elapsedText={elapsed(run.startedAt, run.endedAt, now)}
          transcript={liveTranscript(run)}
          expanded={expanded === run.runId}
          onToggle={() => setExpanded((prev) => (prev === run.runId ? null : run.runId))}
          {...(run.status === "running"
            ? { onCancel: () => session.cancelAgentRun(run.runId) }
            : {})}
        />
      ))}

      {persisted
        .filter((thread) => !liveIds.has(thread.id))
        .map((thread) => {
          const meta = thread.agent;
          if (!meta) return null;
          return (
            <RunRow
              key={thread.id}
              title={meta.label || thread.title}
              tier={meta.tier}
              mode={meta.mode}
              status={meta.status}
              elapsedText={elapsed(thread.createdAt, thread.updatedAt, now)}
              transcript={persistedTranscript(thread)}
              expanded={expanded === thread.id}
              onToggle={() => setExpanded((prev) => (prev === thread.id ? null : thread.id))}
            />
          );
        })}
    </div>
  );
}
