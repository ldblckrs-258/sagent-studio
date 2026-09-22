"use client";

import { findPendingApproval } from "@/chat/approval-pending";
import { useChatStore } from "@/chat/store";
import { useSession } from "@/session/session-context";
import { redactForDisplay, redactSecrets } from "@/tools/redact";
import { Button } from "@/ui/primitives";
import { installApprovalSoundUnlock, playApprovalChime } from "@/ui/approval-sound";
import { ShieldAlert } from "lucide-react";
import { useEffect, useRef } from "react";

/**
 * A pending tool approval surfaced as a floating popover directly above the
 * composer. The same request is also rendered inline inside the tool call,
 * which may be collapsed; this keeps the decision impossible to miss without
 * expanding the tool group.
 */
export function ApprovalPrompt() {
  const session = useSession();
  const messages = useChatStore((s) =>
    s.activeThreadId ? s.threads[s.activeThreadId]?.messages : undefined,
  );
  const pending = messages ? findPendingApproval(messages) : null;
  const approvalId = pending?.approvalId ?? null;
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    installApprovalSoundUnlock();
  }, []);

  useEffect(() => {
    if (approvalId) playApprovalChime(approvalId);
  }, [approvalId]);

  useEffect(() => {
    if (approvalId) dialogRef.current?.focus();
  }, [approvalId]);

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

  const detail =
    pending.prompt !== undefined
      ? redactSecrets(pending.prompt)
      : (() => {
          try {
            return JSON.stringify(redactForDisplay(pending.input ?? {}), null, 2);
          } catch {
            return "[unserializable]";
          }
        })();

  const isChangeMode = pending.toolName === "change_mode";

  return (
    <div
      ref={dialogRef}
      role="alertdialog"
      aria-modal="false"
      aria-label={`Approve ${pending.toolName}`}
      data-slot="approval-prompt"
      tabIndex={-1}
      className="animate-in fade-in slide-in-from-bottom-2 absolute inset-x-0 bottom-full z-40 mb-2 outline-none duration-200 ease-out-quart"
    >
      <div className="border-caution-rule bg-surface overflow-hidden rounded-lg border shadow-[0_18px_44px_-18px_rgba(0,0,0,0.45)]">
        <div className="flex items-start gap-3 p-3">
          <span
            aria-hidden
            className="border-caution-rule bg-caution-soft text-caution mt-px inline-flex size-8 shrink-0 items-center justify-center rounded-md border"
          >
            <ShieldAlert className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-caution text-[10.5px] font-semibold tracking-[0.14em] uppercase">
              Approval required
            </p>
            <p className="text-ink mt-0.5 text-sm">
              Allow{" "}
              <span className="bg-paper-sunk rounded-sm px-1.5 py-0.5 font-mono text-xs">
                {pending.toolName}
              </span>{" "}
              to run?
            </p>
            <pre className="border-rule bg-paper-sunk text-muted mt-2 max-h-36 overflow-auto rounded-sm border px-2.5 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {detail}
            </pre>
          </div>
        </div>
        <div className="border-rule bg-caution-soft/40 flex flex-wrap items-center justify-end gap-2 border-t px-3 py-2">
          <Button size="sm" variant="quiet" onClick={() => respond(false)}>
            Deny
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => respond(true, "allow-once")}
          >
            Allow once
          </Button>
          {!isChangeMode && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => respond(true, "allow-always")}
            >
              Always allow
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
