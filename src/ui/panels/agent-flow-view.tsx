"use client";

/*
  This module owns the flow's view vocabulary (status tints, elapsed
  formatting) beside the component that renders it, so the panel row and the
  detail header cannot drift. Fast refresh therefore sees the mixed exports.
*/
/* eslint-disable react-refresh/only-export-components */

import { AssistantRuntimeProvider, ComposerPrimitive, ThreadPrimitive } from "@assistant-ui/react";
import { ArrowLeft, CircleStop } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { normalizeThreadMessages, uiMessagesFromEvents } from "../../agents/run-messages";
import type { AgentRunRecord } from "../../agents/store";
import { agentRunStore } from "../../agents/store";
import type { ChatThread } from "../../chat/types";
import type { UIMessage } from "ai";
import { useSubAgentRuntime } from "../../chat/use-subagent-runtime";
import { useSession } from "../../session/session-context";
import { ThreadMessage } from "../../components/assistant-ui/elements/thread.aui";
import { AgentApprovalCard } from "../agent-approval";
import { asMode, asTier, ModeChip, TierChip } from "../agent-chips";
import { COMPOSER_SHELL } from "../conversation";
import { Button } from "../primitives";
import { useRegistryVersion } from "../use-registry-version";

export const STATUS_TINT: Record<string, string> = {
  running: "text-accent",
  completed: "text-positive",
  interrupted: "text-caution",
  denied: "text-caution",
  aborted: "text-muted",
  stopped: "text-caution",
  error: "text-danger",
  limit_exceeded: "text-danger",
  invalid_input: "text-danger",
};

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

export function elapsed(
  startedAt: number,
  endedAt: number | undefined,
  now: number,
): string {
  const seconds = Math.max(0, Math.round(((endedAt ?? now) - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/**
 * Drops one optimistic echo per matching `user-message` event, so the store
 * stays authoritative and a second identical send still shows until its own
 * event arrives.
 */
function reconcileOptimistic(
  optimistic: readonly string[],
  events: AgentRunRecord["events"],
): string[] {
  const remaining = new Map<string, number>();
  for (const text of optimistic) remaining.set(text, (remaining.get(text) ?? 0) + 1);
  for (const event of events) {
    if (event.type !== "user-message") continue;
    const count = remaining.get(event.text);
    if (count === undefined) continue;
    if (count <= 1) remaining.delete(event.text);
    else remaining.set(event.text, count - 1);
  }
  const extras: string[] = [];
  for (const [text, count] of remaining) {
    for (let index = 0; index < count; index += 1) extras.push(text);
  }
  return extras;
}

function composerBlockReason(status: string, stopping: boolean): string | null {
  if (stopping) return "Stopping the run…";
  if (status === "running") return null;
  if (status === "completed") return "This run finished; steering is closed.";
  if (status === "stopped") return "You stopped this run; steering is closed.";
  if (status === "interrupted") return "This run was interrupted; steering is closed.";
  if (status === "denied") return "This run was denied; steering is closed.";
  if (status === "aborted") return "This run was aborted; steering is closed.";
  return "This run ended; steering is closed.";
}

/**
 * The flow of one delegated run, rendered with the main thread's own message
 * components. A runtime is mounted for the run so `ThreadMessage` can draw the
 * same user bubbles, assistant prose, markdown, and tool-call views, and the
 * composer is the same assistant-ui input the main thread uses. Live records
 * come from `agentRunStore`; a settled run falls back to its persisted child
 * thread.
 */
export function AgentFlowView({
  runId,
  persisted,
  now,
  onBack,
}: {
  runId: string;
  persisted: ChatThread[];
  now: number;
  onBack(): void;
}) {
  const session = useSession();
  useRegistryVersion(agentRunStore);
  const record = agentRunStore.get(runId);
  const thread = useMemo(
    () => persisted.find((entry) => entry.id === runId),
    [persisted, runId],
  );

  const status = record?.status ?? thread?.agent?.status ?? "interrupted";
  const label = record?.label ?? thread?.agent?.label ?? thread?.title ?? "Agent run";
  const mode = asMode(record?.mode ?? thread?.agent?.mode);
  const tier = asTier(record?.tier ?? thread?.agent?.tier);
  const startedAt = record?.startedAt ?? thread?.createdAt ?? now;
  const endedAt = record?.endedAt ?? (record ? undefined : thread?.updatedAt);
  const isRunning = status === "running";

  const [optimistic, setOptimistic] = useState<string[]>([]);
  const [stopping, setStopping] = useState(false);

  // A settled run has closed its steering channel, so an echo the store never
  // reconciled with a `user-message` event can never be delivered.
  const activeOptimistic = isRunning ? optimistic : [];
  const extras = reconcileOptimistic(activeOptimistic, record?.events ?? []);

  const messages = useMemo((): UIMessage[] => {
    if (record) return uiMessagesFromEvents(record.runId, record.prompt, record.events, !isRunning);
    if (thread) return normalizeThreadMessages(thread.messages);
    return [];
  }, [record, thread, isRunning]);

  const runtimeMessages = useMemo((): UIMessage[] => {
    if (extras.length === 0) return messages;
    return [
      ...messages,
      ...extras.map((text, index): UIMessage => ({
        id: `optimistic:${index}:${text}`,
        role: "user",
        parts: [{ type: "text", text }],
      })),
    ];
  }, [messages, extras]);

  const onSend = useCallback(
    (text: string): void => {
      if (!session.steerAgentRun(runId, text)) return;
      setOptimistic((previous) => [...previous, text]);
    },
    [session, runId, setOptimistic],
  );

  const runtime = useSubAgentRuntime(runtimeMessages, onSend);

  const isStopping = stopping && isRunning;
  const blockReason = composerBlockReason(status, isStopping);
  const approvals = record?.approvals ?? [];
  const error = record?.result?.error;
  const hasAssistantOutput = messages.some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some(
        (part) =>
          (part.type === "text" && part.text.trim().length > 0) ||
          part.type === "dynamic-tool" ||
          part.type.startsWith("tool-"),
      ),
  );

  function stop(): void {
    if (stopping) return;
    setStopping(true);
    if (!session.stopAgentRun(runId)) setStopping(false);
  }

  return (
    <div className="flex min-h-full min-w-0 flex-col">
      <div className="border-rule bg-paper/95 sticky top-0 z-10 flex items-center gap-1.5 border-b px-1.5 py-1.5 backdrop-blur">
        <Button
          variant="quiet"
          size="sm"
          icon={<ArrowLeft size={14} strokeWidth={1.75} />}
          onClick={onBack}
          aria-label="Back to agent list"
          className="shrink-0"
        >
          Back
        </Button>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">{label}</span>
        <span
          aria-hidden="true"
          className={`size-2 shrink-0 rounded-full ${STATUS_DOT[status] ?? "bg-muted"}`}
        />
        <span className={`shrink-0 text-[11px] ${STATUS_TINT[status] ?? "text-muted"}`}>
          {isStopping ? "stopping" : status}
        </span>
      </div>

      <div className="border-rule flex min-w-0 flex-wrap items-center gap-2 border-b px-1.5 py-1">
        <ModeChip mode={mode} />
        <TierChip tier={tier} />
        <span className="numeric text-faint ms-auto font-mono text-[10px]">
          {elapsed(startedAt, endedAt, now)}
        </span>
      </div>

      {approvals.length > 0 ? (
        <div className="flex min-w-0 flex-col px-1.5 pt-2">
          {approvals.map((approval) => (
            <AgentApprovalCard
              key={approval.id}
              approval={approval}
              {...(label ? { label } : {})}
            />
          ))}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-danger px-3 py-2 text-xs break-words">
          {error}
        </p>
      ) : null}

      {status === "stopped" ? (
        <p className="text-caution px-3 py-2 text-[11px]">
          This run was stopped before it finished.
        </p>
      ) : null}

      {messages.length === 0 ? (
        <p className="text-muted px-3 py-3 text-xs leading-relaxed">
          {record || thread ? "Loading the run's flow…" : "Loading run…"}
        </p>
      ) : null}

      {messages.length > 0 && !hasAssistantOutput && !isRunning ? (
        <p className="text-faint px-3 py-2 text-xs leading-relaxed">(no output)</p>
      ) : null}

      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root className="flex min-w-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport className="flex min-w-0 flex-1 flex-col gap-4 px-2 py-3">
            <ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>

        <div className="bg-paper sticky bottom-0 mt-1 px-1.5 pt-1.5 pb-2">
          <ComposerPrimitive.Root className={`${COMPOSER_SHELL} p-1.5`}>
            <ComposerPrimitive.Input
              placeholder="Steer the agent…"
              aria-label="Steer the agent"
              disabled={blockReason !== null}
              rows={1}
              className="text-ink placeholder:text-faint max-h-32 min-h-8 w-full resize-none bg-transparent px-2 py-1 text-base leading-6 outline-none disabled:cursor-not-allowed"
            />
            <div className="mt-0.5 flex min-w-0 items-center justify-between gap-2 px-0.5">
              <span className="text-faint min-w-0 text-[10px] leading-tight break-words">
                {blockReason ?? "Enter to send · Shift+Enter for a new line"}
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                {isRunning ? (
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<CircleStop size={13} strokeWidth={1.75} />}
                    onClick={stop}
                    disabled={isStopping}
                    aria-label="Force-stop agent run"
                  >
                    {isStopping ? "Stopping…" : "Stop"}
                  </Button>
                ) : null}
                {blockReason === null ? (
                  <ComposerPrimitive.Send asChild>
                    <Button size="sm" variant="primary">
                      Send
                    </Button>
                  </ComposerPrimitive.Send>
                ) : (
                  <Button size="sm" variant="primary" disabled>
                    Send
                  </Button>
                )}
              </span>
            </div>
          </ComposerPrimitive.Root>
        </div>
      </AssistantRuntimeProvider>
    </div>
  );
}
