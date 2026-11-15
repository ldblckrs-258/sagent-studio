import { useEffect, useState } from "react";
import { findPendingApproval } from "../chat/approval-pending";
import { useChatStore } from "../chat/store";
import { useAgentPanelStore } from "../session/agent-panel-state";
import { installApprovalSoundUnlock, playApprovalChime } from "./approval-sound";

export type ShellView = "chat" | "playground";

export const SHELL_VIEWS: readonly ShellView[] = ["chat", "playground"];
export const VIEW_LABEL: Record<ShellView, string> = { chat: "Chat", playground: "Playground" };
export const VIEW_STATE_KEY = "sagent.view.v1";

export function readShellView(): ShellView {
  if (typeof sessionStorage === "undefined") return "chat";
  try {
    const raw = sessionStorage.getItem(VIEW_STATE_KEY);
    return raw !== null && (SHELL_VIEWS as readonly string[]).includes(raw) ? (raw as ShellView) : "chat";
  } catch {
    return "chat";
  }
}

export function useShellView() {
  const [view, setView] = useState<ShellView>(readShellView);
  const pendingApprovalId = useChatStore((s) => {
    const messages = s.activeThreadId ? s.threads[s.activeThreadId]?.messages : undefined;
    return messages ? (findPendingApproval(messages)?.approvalId ?? null) : null;
  });

  useEffect(() => {
    if (typeof sessionStorage === "undefined") return;
    try {
      sessionStorage.setItem(VIEW_STATE_KEY, view);
    } catch {
      return;
    }
  }, [view]);

  useEffect(() => {
    if (view !== "playground") return;
    installApprovalSoundUnlock();
    if (pendingApprovalId) playApprovalChime(pendingApprovalId);
  }, [view, pendingApprovalId]);

  useEffect(
    () =>
      useAgentPanelStore.subscribe((state, prev) => {
        if (state.selectedRunId !== null && state.selectedRunId !== prev.selectedRunId) setView("chat");
      }),
    [],
  );

  return { view, setView, pendingApprovalId };
}
