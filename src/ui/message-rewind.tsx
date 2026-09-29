"use client";

import { useAui, useAuiState } from "@assistant-ui/react";
import { Undo2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { agentRunStore } from "../agents/store";
import type { RewindFiles, RewindPreview, RewindResult } from "../chat/engine";
import { ChatRewindBusyError } from "../chat/errors";
import { useChatStore } from "../chat/store";
import { pluralize } from "../components/assistant-ui/elements/tool-view/helpers";
import { TooltipIconButton } from "../components/assistant-ui/elements/tooltip-icon-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { useSession } from "../session/session-context";
import { commandsFromMessage } from "../terminal/transcript";
import { Button } from "./primitives";
import { useRegistryVersion } from "./use-registry-version";

const BUSY_MESSAGE = "Wait for the run, sub-agents, and compaction to finish";

const CONVERSATION_ONLY: Record<Exclude<RewindFiles, "ok">, string> = {
  "no-marker": "This message was sent before file rewind existed.",
  "no-workspace": "No workspace folder is open for this conversation.",
  "folder-mismatch":
    "The conversation now uses a different folder than when this message was sent.",
  expired:
    "The file history from this message is older than the journal keeps.",
};

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function useThreadBusy(threadId: string | null): boolean {
  useRegistryVersion(agentRunStore);
  const running = useChatStore(
    (s) => threadId !== null && (s.runningThreads[threadId] ?? 0) > 0,
  );
  const compacting = useChatStore(
    (s) => threadId !== null && s.compactingThreads[threadId] === true,
  );
  const agents =
    threadId !== null &&
    agentRunStore.list(threadId).some((run) => run.status === "running");
  return running || compacting || agents;
}

export function RewindButton({ onSelect }: { onSelect: () => void }) {
  const threadId = useChatStore((s) => s.activeThreadId);
  const messageId = useAuiState((s) => s.message.id);
  const inThread = useChatStore((s) => {
    const thread =
      s.activeThreadId === null ? undefined : s.threads[s.activeThreadId];
    return (
      thread?.messages.some((message) => message.id === messageId) === true
    );
  });
  const busy = useThreadBusy(threadId);
  if (!inThread) return null;
  return (
    <TooltipIconButton
      tooltip={busy ? BUSY_MESSAGE : "Rewind to here"}
      aria-disabled={busy}
      onClick={() => {
        if (!busy) onSelect();
      }}
      className="aui-user-action-rewind aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
    >
      <Undo2Icon />
    </TooltipIconButton>
  );
}

function PathList({
  label,
  paths,
  tone,
}: {
  label: string;
  paths: string[];
  tone?: "caution";
}) {
  if (paths.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p
        className={
          tone === "caution" ? "text-caution text-xs" : "text-ink text-xs"
        }
      >
        {label}
      </p>
      <ul className="flex flex-col gap-0.5">
        {paths.map((path) => (
          <li key={path} className="text-muted truncate font-mono text-xs">
            {path}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CommandsNotice({ commands }: { commands: string[] }) {
  if (commands.length === 0) return null;
  return (
    <div data-slot="commands-not-undone" className="flex flex-col gap-1">
      <p className="text-caution text-xs">
        Commands are not undone. This span ran{" "}
        {pluralize(commands.length, "command")}:
      </p>
      <ul className="flex flex-col gap-0.5">
        {commands.map((command, index) => (
          <li key={index} className="text-muted truncate font-mono text-xs">
            {command}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FilesSummary({ preview }: { preview: RewindPreview }) {
  if (preview.files !== "ok") {
    return (
      <p className="text-caution text-xs">
        {CONVERSATION_ONLY[preview.files]} Only the conversation will be
        rewound.
      </p>
    );
  }
  const empty =
    preview.restore.length +
      preview.remove.length +
      preview.unrestorable.length +
      preview.conflicts.length ===
    0;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted text-xs">
        Files return to the moment this message was sent, including writes by
        background agents after that moment.
      </p>
      {empty ? (
        <p className="text-ink text-xs">No file changes to undo.</p>
      ) : null}
      <PathList
        label={`Restore ${pluralize(preview.restore.length, "file")}`}
        paths={preview.restore}
      />
      <PathList
        label={`Remove ${pluralize(preview.remove.length, "file")}`}
        paths={preview.remove}
      />
      <PathList
        label="Changed outside the agent; will be left as is"
        paths={preview.conflicts}
        tone="caution"
      />
      <PathList
        label="Cannot be restored"
        paths={preview.unrestorable}
        tone="caution"
      />
    </div>
  );
}

export function RewindDialog({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const aui = useAui();
  const threadId = useChatStore((s) => s.activeThreadId);
  const messageId = useAuiState((s) => s.message.id);
  const draft = useAuiState((s) => s.thread.composer.text);
  const [preview, setPreview] = useState<RewindPreview | null>(null);
  const [failure, setFailure] = useState<RewindResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useThreadBusy(threadId);
  const messages = useChatStore((s) =>
    threadId === null ? undefined : s.threads[threadId]?.messages,
  );
  const commands = messages ? commandsFromMessage(messages, messageId) : [];

  useEffect(() => {
    if (threadId === null) return;
    let cancelled = false;
    session
      .engineFor(threadId)
      .previewRewind(threadId, messageId)
      .then(
        (next) => {
          if (!cancelled) setPreview(next);
        },
        (cause: unknown) => {
          if (!cancelled) setError(messageOf(cause));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [session, threadId, messageId]);

  const confirm = async (): Promise<void> => {
    if (threadId === null) return;
    const composer = aui.thread.composer();
    setPending(true);
    setError(null);
    try {
      const result = await session
        .engineFor(threadId)
        .rewind(threadId, messageId);
      if (result.failed) {
        setFailure(result);
        return;
      }
      composer.setText(result.text);
      onClose();
    } catch (cause) {
      setError(
        cause instanceof ChatRewindBusyError
          ? `${BUSY_MESSAGE}.`
          : messageOf(cause),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        data-slot="message-rewind-dialog"
        className="max-h-[80vh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>Rewind to this message?</DialogTitle>
          <DialogDescription>
            {preview
              ? `Removes this message and everything after it (${pluralize(preview.removedMessages, "message")}). Its text returns to the composer.`
              : "Checking what a rewind would change…"}
          </DialogDescription>
        </DialogHeader>
        {preview ? <FilesSummary preview={preview} /> : null}
        {preview ? <CommandsNotice commands={commands} /> : null}
        {preview && draft.trim().length > 0 ? (
          <p className="text-caution text-xs">
            The draft in the composer will be replaced by this message's text.
          </p>
        ) : null}
        {busy ? <p className="text-caution text-xs">{BUSY_MESSAGE}.</p> : null}
        {failure?.failed ? (
          <div role="alert" className="flex flex-col gap-2">
            <p className="text-danger text-xs break-words">
              Rewind stopped at{" "}
              <span className="font-mono">{failure.failed.path}</span>:{" "}
              {failure.failed.message} The conversation was not changed.
            </p>
            <PathList
              label="Already restored"
              paths={[...failure.restored, ...failure.removed]}
            />
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-danger text-xs break-words">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            size="sm"
            variant="quiet"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => void confirm()}
            disabled={pending || preview === null || busy || failure !== null}
          >
            Rewind
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
