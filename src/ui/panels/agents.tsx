"use client";

import { Bot, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { agentRunStore } from "../../agents/store";
import { listAgentRuns } from "../../chat/persistence";
import { useChatStore } from "../../chat/store";
import type { ChatThread } from "../../chat/types";
import { useAgentPanelStore } from "../../session/agent-panel-state";
import { useSession } from "../../session/session-context";
import { asMode, asTier, ModeChip, TierChip } from "../agent-chips";
import { AgentApprovalCard } from "../agent-approval";
import { Button, EmptyState } from "../primitives";
import { useRegistryVersion } from "../use-registry-version";
import { AgentFlowView, STATUS_TINT, elapsed } from "./agent-flow-view";

const STATUS_DOT: Record<string, string> = {
  running: "bg-accent",
  completed: "bg-positive",
  interrupted: "bg-caution",
  denied: "bg-caution",
  aborted: "bg-muted",
  stopped: "bg-caution",
  error: "bg-danger",
  limit_exceeded: "bg-danger",
  invalid_input: "bg-danger",
};

export function RunRow({
  title,
  tier,
  mode,
  status,
  elapsedText,
  selected,
  stopping,
  onSelect,
  onStop,
  rowRef,
}: {
  title: string;
  tier: string;
  mode: string;
  status: string;
  elapsedText: string;
  selected: boolean;
  stopping?: boolean;
  onSelect(): void;
  onStop?: () => void;
  rowRef?: (element: HTMLButtonElement | null) => void;
}) {
  const running = status === "running";
  return (
    <div
      className={`border-rule border-b transition-colors duration-150 ${
        selected ? "bg-accent-soft/40" : ""
      }`}
    >
      <div className="flex items-center gap-1.5 px-1.5 py-1.5">
        <button
          type="button"
          ref={rowRef}
          aria-current={selected ? "true" : undefined}
          onClick={onSelect}
          className="ease-out-quart group flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-sm text-left transition-colors duration-150 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent-rule focus-visible:outline-none"
        >
          <span
            aria-hidden="true"
            className={`size-2 shrink-0 rounded-full ${STATUS_DOT[status] ?? "bg-muted"}`}
          />
          <span className="min-w-0 flex-1 truncate text-xs text-ink">{title}</span>
          <ChevronRight
            size={13}
            strokeWidth={1.75}
            className="text-faint shrink-0 transition-transform duration-150 group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </button>
        {running && onStop ? (
          <Button
            size="sm"
            variant="quiet"
            onClick={onStop}
            disabled={stopping}
            aria-label="Stop agent run"
            className="shrink-0"
          >
            {stopping ? "Stopping…" : "Stop"}
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 px-1.5 pb-2 pl-[22px]">
        <span className={`text-[11px] ${STATUS_TINT[status] ?? "text-muted"}`}>{status}</span>
        <ModeChip mode={asMode(mode)} />
        <TierChip tier={asTier(tier)} />
        <span className="numeric text-faint ms-auto font-mono text-[10px]">{elapsedText}</span>
      </div>
    </div>
  );
}

/**
 * Live and persisted delegated runs for the active conversation. The panel is a
 * two-state surface: a sectioned list (active runs first), and the flow of the
 * run the user opened. Selection lives in `useAgentPanelStore` so a sub-agent
 * tool call in the transcript can open the panel straight to its run.
 */
export function AgentsPanel() {
  const session = useSession();
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  const selectedRunId = useAgentPanelStore((s) => s.selectedRunId);
  useRegistryVersion(agentRunStore);
  const [persisted, setPersisted] = useState<ChatThread[]>([]);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const focusTargetRef = useRef<string | null>(null);

  const live = agentRunStore.list(activeThreadId ?? undefined);
  const liveIds = new Set(live.map((run) => run.runId));
  const settledSignature = live
    .filter((run) => run.status !== "running")
    .map((run) => `${run.runId}:${run.status}`)
    .join(",");
  const loadKey = `${activeThreadId ?? ""}|${settledSignature}`;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const runs = await listAgentRuns(activeThreadId ?? undefined);
      if (!cancelled) setPersisted(runs);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeThreadId, loadKey]);

  const selectedLive = selectedRunId
    ? live.find((run) => run.runId === selectedRunId)
    : undefined;
  const selectedThread = selectedRunId
    ? persisted.find((thread) => thread.id === selectedRunId)
    : undefined;
  const showDetail =
    selectedRunId !== null && (selectedLive !== undefined || selectedThread !== undefined);

  useEffect(() => {
    if (selectedRunId !== null) return;
    const target = focusTargetRef.current;
    if (target === null) return;
    focusTargetRef.current = null;
    rowRefs.current.get(target)?.focus();
  }, [selectedRunId]);

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
  const visibleApprovals = showDetail
    ? approvalsWithLabel.filter((entry) => entry.approval.runId !== selectedRunId)
    : approvalsWithLabel;

  const activeRuns = live.filter((run) => run.status === "running");
  const recentLive = live.filter((run) => run.status !== "running");
  const recentPersisted = persisted.filter(
    (thread) => !liveIds.has(thread.id) && thread.agent !== undefined,
  );
  const recentCount = recentLive.length + recentPersisted.length;

  function stopRun(runId: string): void {
    setStopping((current) => new Set(current).add(runId));
    if (!session.stopAgentRun(runId)) {
      setStopping((current) => {
        const next = new Set(current);
        next.delete(runId);
        return next;
      });
    }
  }

  function back(): void {
    if (selectedRunId !== null) focusTargetRef.current = selectedRunId;
    useAgentPanelStore.getState().clear();
  }

  const empty = live.length === 0 && persisted.length === 0;

  return (
    <div className="flex min-w-0 flex-col py-1">
      {visibleApprovals.map(({ approval, label }) => (
        <AgentApprovalCard key={approval.id} approval={approval} {...(label ? { label } : {})} />
      ))}

      {showDetail && selectedRunId !== null ? (
        <AgentFlowView
          key={selectedRunId}
          runId={selectedRunId}
          persisted={persisted}
          now={now}
          onBack={back}
        />
      ) : empty ? (
        <div className="px-3 py-4">
          <EmptyState
            icon={<Bot size={18} strokeWidth={1.5} />}
            title="No delegated agents yet"
            hint="The model can call spawn_agent to hand a bounded task to a sub-agent. Its run appears here."
          />
        </div>
      ) : (
        <>
          {activeRuns.length > 0 ? (
            <p className="label-micro text-faint px-3 pt-1 pb-1.5">
              Active · {activeRuns.length}
            </p>
          ) : null}
          {activeRuns.map((run) => (
            <RunRow
              key={run.runId}
              title={run.label || run.prompt.slice(0, 60) || "Agent run"}
              tier={run.tier}
              mode={run.mode}
              status={run.status}
              elapsedText={elapsed(run.startedAt, run.endedAt, now)}
              selected={selectedRunId === run.runId}
              stopping={stopping.has(run.runId)}
              onSelect={() => useAgentPanelStore.getState().open(run.runId)}
              onStop={() => stopRun(run.runId)}
              rowRef={(element) => {
                if (element) rowRefs.current.set(run.runId, element);
                else rowRefs.current.delete(run.runId);
              }}
            />
          ))}

          {recentCount > 0 ? (
            <p className="label-micro text-faint px-3 pt-2 pb-1.5">Recent · {recentCount}</p>
          ) : null}
          {recentLive.map((run) => (
            <RunRow
              key={run.runId}
              title={run.label || run.prompt.slice(0, 60) || "Agent run"}
              tier={run.tier}
              mode={run.mode}
              status={run.status}
              elapsedText={elapsed(run.startedAt, run.endedAt, now)}
              selected={selectedRunId === run.runId}
              onSelect={() => useAgentPanelStore.getState().open(run.runId)}
              rowRef={(element) => {
                if (element) rowRefs.current.set(run.runId, element);
                else rowRefs.current.delete(run.runId);
              }}
            />
          ))}
          {recentPersisted.map((thread) => {
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
                selected={selectedRunId === thread.id}
                onSelect={() => useAgentPanelStore.getState().open(thread.id)}
                rowRef={(element) => {
                  if (element) rowRefs.current.set(thread.id, element);
                  else rowRefs.current.delete(thread.id);
                }}
              />
            );
          })}
        </>
      )}
    </div>
  );
}
