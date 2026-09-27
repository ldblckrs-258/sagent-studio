"use client";

import { ChevronRight, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { pluralize } from "../components/assistant-ui/elements/tool-view/helpers";
import { ToolDiff } from "../components/assistant-ui/elements/tool-view/primitives";
import { useSession } from "../session/session-context";
import type { RunFileChange } from "../workspace/journal";
import type { RunRevertOutcome } from "../workspace/run-journal";
import { Button } from "./primitives";

function ChangeRow({ change }: { change: RunFileChange }) {
  return (
    <details data-slot="run-change" className="group border-rule border-t first:border-t-0">
      <summary className="hover:text-ink flex cursor-pointer list-none items-center gap-2 py-1 text-xs">
        <ChevronRight
          size={12}
          strokeWidth={1.75}
          aria-hidden="true"
          className="text-faint shrink-0 transition-transform duration-150 group-open:rotate-90"
        />
        <span className="text-ink min-w-0 flex-1 truncate font-mono">{change.path}</span>
        <span className="text-faint shrink-0 text-[10px]">{change.kind}</span>
        {change.partial ? (
          <span className="text-caution shrink-0 text-[10px]">too large to diff</span>
        ) : (
          <span className="numeric shrink-0 font-mono text-[10px]">
            <span className="text-positive">+{change.addedLines}</span>{" "}
            <span className="text-danger">−{change.removedLines}</span>
          </span>
        )}
      </summary>
      {change.diff.length > 0 ? (
        <div className="pb-2">
          <ToolDiff text={`--- a/${change.path}\n+++ b/${change.path}\n${change.diff}`} />
        </div>
      ) : null}
    </details>
  );
}

function OutcomeSummary({ outcome }: { outcome: RunRevertOutcome }) {
  return (
    <div data-slot="run-revert-outcome" role="status" className="flex flex-col gap-1 text-xs">
      <p className="text-ink">Reverted {pluralize(outcome.reverted.length, "file")}.</p>
      {outcome.conflicts.map((path) => (
        <p key={`conflict:${path}`} className="text-caution break-words">
          Skipped <span className="font-mono">{path}</span>: it changed after this run.
        </p>
      ))}
      {outcome.unrestorable.map((path) => (
        <p key={`unrestorable:${path}`} className="text-caution break-words">
          Skipped <span className="font-mono">{path}</span>: its content was too large to record.
        </p>
      ))}
    </div>
  );
}

export function RunChanges({ runId, status }: { runId: string; status: string }) {
  const session = useSession();
  const [changes, setChanges] = useState<RunFileChange[]>([]);
  const [expired, setExpired] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [outcome, setOutcome] = useState<RunRevertOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const running = status === "running";

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await session.agentRunChanges(runId);
        if (cancelled) return;
        setChanges(next.changes);
        setExpired(next.expired);
      } catch {
        if (!cancelled) setChanges([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, runId, status, version]);

  const revert = useCallback(async (): Promise<void> => {
    setReverting(true);
    setError(null);
    try {
      const result = await session.revertAgentRun(runId);
      if ("error" in result) setError(result.error);
      else setOutcome(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReverting(false);
      setConfirming(false);
      setVersion((current) => current + 1);
    }
  }, [session, runId]);

  if (changes.length === 0 && !expired && outcome === null && error === null) return null;

  return (
    <section
      data-slot="run-changes"
      aria-label="Files changed by this run"
      className="border-rule bg-surface flex flex-col gap-2 rounded-sm border px-2.5 py-2"
    >
      <div className="flex items-center gap-2">
        <span className="label-micro flex-1">{pluralize(changes.length, "file")} changed</span>
        {confirming ? (
          <>
            <span className="text-ink text-xs">Revert {pluralize(changes.length, "file")}?</span>
            <Button size="sm" variant="quiet" onClick={() => setConfirming(false)} disabled={reverting}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void revert()} disabled={reverting} aria-label="Confirm revert">
              Confirm
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="quiet"
            icon={<RotateCcw size={13} strokeWidth={1.75} />}
            onClick={() => setConfirming(true)}
            disabled={running || expired || outcome !== null || changes.length === 0}
            title={running ? "Stop or wait for the run before reverting it." : undefined}
          >
            Revert this run
          </Button>
        )}
      </div>
      {changes.length > 0 ? (
        <div className="flex flex-col">
          {changes.map((change) => (
            <ChangeRow key={change.path} change={change} />
          ))}
        </div>
      ) : null}
      {expired ? (
        <p className="text-caution text-xs">
          Part of this run's history is older than the journal keeps, so it can no longer be reverted safely.
        </p>
      ) : null}
      {outcome ? <OutcomeSummary outcome={outcome} /> : null}
      {error ? (
        <p role="alert" className="text-danger text-xs break-words">
          {error}
        </p>
      ) : null}
    </section>
  );
}
