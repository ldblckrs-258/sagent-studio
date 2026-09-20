"use client";

import { findPendingApproval } from "@/chat/approval-pending";
import { useChatStore } from "@/chat/store";
import { useSession } from "@/session/session-context";
import { Button } from "@/ui/primitives";

/**
 * A pending tool approval surfaced just above the composer. The same request is
 * also rendered inside the tool call, which may be collapsed; this keeps the
 * decision reachable without expanding the tool group.
 */
export function ApprovalPrompt() {
  const session = useSession();
  const messages = useChatStore((s) =>
    s.activeThreadId ? s.threads[s.activeThreadId]?.messages : undefined,
  );
  const pending = messages ? findPendingApproval(messages) : null;
  if (!pending) return null;

  const respond = (approved: boolean, optionId?: string) => {
    const id = useChatStore.getState().activeThreadId;
    if (!id) return;
    void session.engineFor(id).respondToApproval(id, {
      approvalId: pending.approvalId,
      approved,
      ...(optionId !== undefined ? { optionId } : {}),
    });
  };

  let detail = pending.prompt;
  if (detail === undefined) {
    try {
      detail = JSON.stringify(pending.input ?? {});
    } catch {
      detail = String(pending.input);
    }
  }

  return (
    <div
      role="alertdialog"
      aria-label={`Approve ${pending.toolName}`}
      data-slot="approval-prompt"
      className="border-caution/45 bg-surface mb-1 flex items-start justify-between gap-3 rounded-sm border p-2.5"
    >
      <div className="min-w-0">
        <p className="text-sm text-ink">
          Approve <span className="font-mono">{pending.toolName}</span>?
        </p>
        <p className="text-muted mt-0.5 truncate font-mono text-xs">{detail}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="sm" variant="secondary" onClick={() => respond(false)}>
          Deny
        </Button>
        <Button size="sm" variant="secondary" onClick={() => respond(true, "allow-once")}>
          Allow once
        </Button>
        <Button size="sm" variant="primary" onClick={() => respond(true, "allow-always")}>
          Always allow
        </Button>
      </div>
    </div>
  );
}
