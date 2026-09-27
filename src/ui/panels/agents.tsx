"use client";

import { Bot, CircleStop, Loader } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { agentRunStore } from "../../agents/store";
import { listAgentRuns } from "../../chat/persistence";
import { useChatStore } from "../../chat/store";
import type { ChatThread } from "../../chat/types";
import { useAgentPanelStore } from "../../session/agent-panel-state";
import { useSession } from "../../session/session-context";
import { pluralize } from "../../components/assistant-ui/elements/tool-view/helpers";
import { ToolChip } from "../../components/assistant-ui/elements/tool-view/primitives";
import { asTier, TierChip } from "../agent-chips";
import { AgentApprovalCard } from "../agent-approval";
import { activityOf, elapsed, isRunning, STATUS_DOT, toolCallCount } from "../agent-status";
import { Button, EmptyState } from "../primitives";
import { useRegistryVersion } from "../use-registry-version";

export function RunRow({
  title,
  tier,
  status,
  activity,
  toolCalls,
  elapsedText,
  hasApproval = false,
  selected,
  stopping,
  onSelect,
  onStop,
  rowRef,
}: {
  title: string;
  tier: string;
  status: string;
  activity: string;
  toolCalls: number;
  elapsedText: string;
  hasApproval?: boolean;
  selected: boolean;
  stopping?: boolean;
  onSelect(): void;
  onStop?: () => void;
  rowRef?: (element: HTMLButtonElement | null) => void;
}) {
  const running = isRunning(status);
  return (
    <div
      className={`border-rule border-b transition-colors duration-150 ${
        selected ? "bg-accent-soft/40" : ""
      }`}
    >
      <div className="flex items-start gap-1.5 px-1.5 py-1.5">
        <button
          type="button"
          ref={rowRef}
          aria-current={selected ? "true" : undefined}
          onClick={onSelect}
          className="ease-out-quart group flex min-h-11 min-w-0 flex-1 flex-col gap-1 rounded-sm py-0.5 text-left transition-colors duration-150 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent-rule focus-visible:outline-none"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {running ? (
              <Loader
                size={12}
                strokeWidth={2}
                className="text-accent shrink-0 animate-spin [animation-duration:1s]"
                aria-hidden="true"
              />
            ) : (
              <span
                aria-hidden="true"
                className={`size-2 shrink-0 rounded-full ${STATUS_DOT[status] ?? "bg-muted"}`}
              />
            )}
            <span className="sr-only">{status}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-ink">{title}</span>
            {hasApproval ? <ToolChip tone="caution">approval</ToolChip> : null}
          </span>
          <span className="text-faint min-w-0 truncate pl-[18px] text-[11px]">
            {activity.length > 0 ? activity : " "}
          </span>
          <span className="flex flex-wrap items-center gap-1.5 pl-[18px]">
            <TierChip tier={asTier(tier)} />
            <span className="text-faint text-[10px]">· {pluralize(toolCalls, "tool")} ·</span>
            <span className="numeric text-faint ms-auto font-mono text-[10px]">{elapsedText}</span>
          </span>
        </button>
        {running && onStop ? (
          <Button
            size="sm"
            variant="quiet"
            icon={<CircleStop size={13} strokeWidth={1.75} />}
            onClick={onStop}
            disabled={stopping}
            aria-label="Stop agent run"
            className="shrink-0"
          />
        ) : null}
      </div>
    </div>
  );
}

export function AgentsPanel() {
  const session = useSession();
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  const selectedRunId = useAgentPanelStore((s) => s.selectedRunId);
  useRegistryVersion(agentRunStore);
  const [persisted, setPersisted] = useState<ChatThread[]>([]);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const previousSelectedRef = useRef<string | null>(null);

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

  useEffect(() => {
    if (selectedRunId === null && previousSelectedRef.current !== null) {
      rowRefs.current.get(previousSelectedRef.current)?.focus();
    }
    previousSelectedRef.current = selectedRunId;
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
      approvals
        .filter((approval) => approval.runId !== selectedRunId)
        .map((approval) => ({
          approval,
          label: live.find((run) => run.runId === approval.runId)?.label,
        })),
    [approvals, live, selectedRunId],
  );

  const activeRuns = live.filter((run) => run.status === "running" || run.approvals.length > 0);
  const activeIds = new Set(activeRuns.map((run) => run.runId));
  const recentLive = live.filter((run) => !activeIds.has(run.runId));
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

  const empty = live.length === 0 && persisted.length === 0;

  return (
    <div className="flex min-w-0 flex-col py-1">
      {approvalsWithLabel.map(({ approval, label }) => (
        <AgentApprovalCard key={approval.id} approval={approval} {...(label ? { label } : {})} />
      ))}

      {empty ? (
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
              status={run.status}
              activity={activityOf(run.messages, run.status)}
              toolCalls={run.toolCalls}
              elapsedText={elapsed(run.startedAt, run.endedAt, now)}
              hasApproval={run.approvals.length > 0}
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
              status={run.status}
              activity={activityOf(run.messages, run.status)}
              toolCalls={run.toolCalls}
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
                status={meta.status}
                activity={activityOf(thread.messages, meta.status)}
                toolCalls={toolCallCount(thread.messages)}
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
