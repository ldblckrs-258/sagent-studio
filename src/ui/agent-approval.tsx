"use client";

import { ShieldAlert } from "lucide-react";
import { useEffect } from "react";
import type { PendingAgentApproval } from "../agents/approval-queue";
import { agentRunStore } from "../agents/store";
import { describeCommandInput } from "../terminal/approval";
import { redactForDisplay, redactSecrets } from "../tools/redact";
import { playApprovalChime } from "./approval-sound";
import { Button } from "./primitives";

/**
 * One queued approval from a delegated agent. Allow/Deny only: a sub-agent must
 * never be able to durably weaken the conversation's saved policy, so there is
 * no "always allow" here.
 */
export function AgentApprovalCard({
  approval,
  label,
}: {
  approval: PendingAgentApproval;
  label?: string;
}) {
  useEffect(() => {
    playApprovalChime(approval.id);
  }, [approval.id]);

  const command = describeCommandInput(approval.toolName, approval.input);
  const detail = (() => {
    if (command !== null) return redactSecrets(command);
    try {
      return JSON.stringify(redactForDisplay(approval.input ?? {}), null, 2);
    } catch {
      return "[unserializable]";
    }
  })();

  return (
    <div
      role="alertdialog"
      aria-label={`Approve ${approval.toolName} for a sub-agent`}
      data-slot="agent-approval"
      className="border-caution-rule bg-caution-soft/40 mx-1 mb-2 rounded-md border px-2 py-2"
    >
      <p className="text-caution flex items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.14em] uppercase">
        <ShieldAlert className="size-3.5" aria-hidden />
        Delegated approval{label ? ` · ${label}` : ""}
      </p>
      <p className="text-ink mt-1 text-xs">
        A sub-agent wants to run{" "}
        <span className="bg-paper-sunk rounded-sm px-1.5 py-0.5 font-mono text-xs">
          {approval.toolName}
        </span>
        .
      </p>
      <pre className="border-rule bg-paper-sunk text-muted mt-2 max-h-32 overflow-auto rounded-sm border px-2 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {detail}
      </pre>
      {approval.reason ? (
        <p className="text-caution mt-1.5 text-[11px]">{redactSecrets(approval.reason)}</p>
      ) : null}
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button size="sm" variant="quiet" onClick={() => agentRunStore.resolveApproval(approval.id, false)}>
          Deny
        </Button>
        <Button size="sm" variant="primary" onClick={() => agentRunStore.resolveApproval(approval.id, true)}>
          Allow
        </Button>
      </div>
    </div>
  );
}
