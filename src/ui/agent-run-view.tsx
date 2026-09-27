"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { UIMessage } from "ai";
import { ArrowLeft, Loader, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { repairLegacyRunMessages } from "../agents/run-transcript";
import { agentRunStore } from "../agents/store";
import { loadThread } from "../chat/persistence";
import { rehydrateThread } from "../chat/sanitize";
import type { ChatThread } from "../chat/types";
import { useSubAgentRuntime } from "../chat/use-subagent-runtime";
import { ThreadShell } from "../components/assistant-ui/elements/thread.aui";
import { useAgentPanelStore } from "../session/agent-panel-state";
import { useSession } from "../session/session-context";
import { AgentApprovalCard } from "./agent-approval";
import { asMode, asTier, ModeChip, ProfileChip, TierChip } from "./agent-chips";
import { formatTokens } from "./context-meter-view";
import { elapsed, STATUS_DOT, STATUS_TINT, toolCallCount } from "./agent-status";
import { Button } from "./primitives";
import { RunChanges } from "./run-changes";
import { UserBubble } from "./conversation";
import { SteerComposer } from "./steer-composer";
import { useRegistryVersion } from "./use-registry-version";

const CLOSED_REASON: Record<string, string> = {
  completed: "This run finished.",
  stopped: "You stopped this run.",
  interrupted: "This run was interrupted.",
  denied: "This run was denied.",
  aborted: "This run was aborted.",
};

const RESUMABLE = new Set(["interrupted", "stopped"]);
const RESUME_MESSAGE = "Continue where you left off.";

function closedReasonFor(
  status: string,
  stopping: boolean,
  state: { available: boolean; continuable: boolean; starting: boolean },
): string | null {
  if (status === "running") return stopping ? "Stopping the run…" : null;
  if (!state.available) return "This run is not available.";
  if (state.starting) return "Starting the agent…";
  if (state.continuable) return null;
  return `${CLOSED_REASON[status] ?? "This run ended."} It was recorded before runs could be continued, so it cannot take new messages.`;
}

function reconcileOptimistic(
  optimistic: readonly string[],
  messages: readonly UIMessage[],
): string[] {
  const remaining = new Map<string, number>();
  for (const text of optimistic) remaining.set(text, (remaining.get(text) ?? 0) + 1);
  for (const message of messages.slice(1)) {
    if (message.role !== "user") continue;
    const text = message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
    const count = remaining.get(text);
    if (count === undefined) continue;
    if (count <= 1) remaining.delete(text);
    else remaining.set(text, count - 1);
  }
  const extras: string[] = [];
  for (const [text, count] of remaining) {
    for (let index = 0; index < count; index += 1) extras.push(text);
  }
  return extras;
}

function usePersistedRun(runId: string, enabled: boolean): ChatThread | null | undefined {
  const [thread, setThread] = useState<ChatThread | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await loadThread(runId);
        if (!cancelled) setThread(loaded ? rehydrateThread(loaded) : null);
      } catch {
        if (!cancelled) setThread(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, enabled]);
  return thread;
}

export function AgentRunView({ runId }: { runId: string }) {
  const session = useSession();
  useRegistryVersion(agentRunStore);
  const record = agentRunStore.get(runId);
  const thread = usePersistedRun(runId, record === undefined);
  const returnFocus = useRef<Element | null>(
    typeof document === "undefined" ? null : document.activeElement,
  );

  const status = record?.status ?? thread?.agent?.status ?? "interrupted";
  const isRunning = status === "running";
  const label = record?.label ?? thread?.agent?.label ?? thread?.title ?? "Agent run";
  const mode = asMode(record?.mode ?? thread?.agent?.mode);
  const tier = asTier(record?.tier ?? thread?.agent?.tier);
  const profile = record?.profile ?? thread?.agent?.profile;
  const startedAt = record?.startedAt ?? thread?.createdAt ?? 0;
  const endedAt = record ? record.endedAt : thread?.updatedAt;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isRunning]);

  const [optimistic, setOptimistic] = useState<string[]>([]);
  const [stopping, setStopping] = useState(false);

  const messages = useMemo((): UIMessage[] => {
    if (record) return record.messages;
    if (thread) return repairLegacyRunMessages(thread.messages);
    return [];
  }, [record, thread]);

  const pending = useMemo(
    () => (isRunning ? reconcileOptimistic(optimistic, messages) : []),
    [messages, optimistic, isRunning],
  );

  const spec = record?.spec ?? thread?.agent?.spec;
  const available = record !== undefined || (thread !== undefined && thread !== null);
  const continuable = !isRunning && available && spec !== undefined;
  const [starting, setStarting] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);

  const continueRun = useCallback(
    async (text: string): Promise<void> => {
      setStarting(true);
      setContinueError(null);
      try {
        const outcome = await session.continueAgentRun(runId, text);
        if (outcome.status !== "running" && outcome.status !== "completed") {
          setContinueError(outcome.message);
        }
      } catch (cause) {
        setContinueError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setStarting(false);
      }
    },
    [session, runId],
  );

  const onSend = useCallback(
    (text: string): void => {
      if (isRunning) {
        if (!session.steerAgentRun(runId, text)) return;
        setOptimistic((previous) => [...previous, text]);
        return;
      }
      if (continuable && !starting) void continueRun(text);
    },
    [session, runId, isRunning, continuable, starting, continueRun],
  );

  const onStop = useCallback((): void => {
    setStopping(true);
    if (!session.stopAgentRun(runId)) setStopping(false);
  }, [session, runId]);

  const runtime = useSubAgentRuntime(messages, { isRunning, onSend, onStop });

  const back = useCallback((): void => {
    const target = returnFocus.current;
    useAgentPanelStore.getState().clear();
    if (target instanceof HTMLElement && target.isConnected) target.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("textarea, input, [role='dialog'], [role='alertdialog']")
      ) {
        return;
      }
      back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back]);

  const isStopping = stopping && isRunning;
  const approvals = record?.approvals ?? [];
  const error = record?.result?.error;
  const loading = record === undefined && thread === undefined;
  const missing = record === undefined && thread === null;

  return (
    <div data-slot="agent-run-view" className="flex h-full min-w-0 flex-col">
      <div className="border-rule bg-paper/95 flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <Button
          variant="quiet"
          size="sm"
          icon={<ArrowLeft size={14} strokeWidth={1.75} />}
          onClick={back}
          aria-label="Back to conversation"
        >
          Conversation
        </Button>
        <span className="text-faint" aria-hidden="true">
          /
        </span>
        <h2 className="text-ink min-w-0 flex-1 truncate text-sm font-medium">{label}</h2>
        <span className="flex shrink-0 items-center gap-1.5">
          {isRunning ? (
            <Loader
              aria-hidden="true"
              className="text-accent size-3.5 animate-spin [animation-duration:1s]"
            />
          ) : (
            <span
              aria-hidden="true"
              className={`size-2 rounded-full ${STATUS_DOT[status] ?? "bg-muted"}`}
            />
          )}
          <span className={`text-xs ${STATUS_TINT[status] ?? "text-muted"}`}>
            {isStopping ? "stopping" : status}
          </span>
        </span>
        {continuable && RESUMABLE.has(status) ? (
          <Button
            variant="quiet"
            size="sm"
            icon={<RotateCw size={13} strokeWidth={1.75} />}
            onClick={() => void continueRun(RESUME_MESSAGE)}
            disabled={starting}
            aria-label="Resume the agent run"
          >
            Resume
          </Button>
        ) : null}
        {profile !== undefined ? <ProfileChip profile={profile} /> : null}
        <ModeChip mode={mode} />
        <TierChip tier={tier} />
        {record?.contextTokens !== undefined && record.contextCap !== undefined ? (
          <span
            data-slot="agent-context-meter"
            title="Context used by this run's next model call"
            className="numeric text-faint font-mono text-[11px]"
          >
            ctx {formatTokens(record.contextTokens)} / {formatTokens(record.contextCap)}
          </span>
        ) : null}
        <span className="numeric text-faint font-mono text-[11px]">
          {toolCallCount(messages)} tools · {elapsed(startedAt, endedAt, now)}
        </span>
      </div>

      <div className="min-h-0 flex-1">
        <AssistantRuntimeProvider runtime={runtime}>
          <ThreadShell
            lead={
              <div className="flex flex-col gap-2 empty:hidden">
                {approvals.map((approval) => (
                  <AgentApprovalCard key={approval.id} approval={approval} label={label} />
                ))}
                {available ? <RunChanges runId={runId} status={status} /> : null}
                {continueError ? (
                  <p role="alert" className="text-danger text-xs break-words">
                    {continueError}
                  </p>
                ) : null}
                {error ? (
                  <p
                    role="alert"
                    className="border-danger-rule bg-danger-soft text-danger rounded-md border px-3 py-2 text-xs break-words"
                  >
                    {error}
                  </p>
                ) : null}
                {status === "stopped" ? (
                  <p className="text-caution text-xs">This run was stopped before it finished.</p>
                ) : null}
                {loading ? <p className="text-muted text-xs">Loading run…</p> : null}
                {missing ? (
                  <p className="text-muted text-xs">This run is no longer available.</p>
                ) : null}
              </div>
            }
            footer={
              <>
                {pending.length > 0 ? (
                  <div data-slot="pending-steers" className="flex flex-col items-end gap-1.5 px-2">
                    {pending.map((text, index) => (
                      <UserBubble key={`${index}:${text}`} className="max-w-[85%] opacity-70">
                        {text}
                      </UserBubble>
                    ))}
                    <span className="text-faint text-[11px]">Waiting for the agent’s next step</span>
                  </div>
                ) : null}
                <SteerComposer
                  closedReason={closedReasonFor(status, isStopping, {
                    available,
                    continuable,
                    starting,
                  })}
                  continuing={!isRunning}
                />
              </>
            }
          />
        </AssistantRuntimeProvider>
      </div>
    </div>
  );
}
