import { X } from "lucide-react";
import { useAttachmentStore, autoAttachmentForThread } from "../chat/attachment-store";
import type { Attachment, AttachmentRecord } from "../chat/attachments";
import { basenameOf } from "../chat/attachments";
import { useChatStore } from "../chat/store";
import { useFileViewStore } from "../session/file-view-state";
import { fileLookFor, folderLookFor } from "./panels/file-icon";

function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index + 1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Chip({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove: () => void;
}) {
  const look =
    attachment.kind === "folder"
      ? folderLookFor(false)
      : fileLookFor(attachment.path);
  const { Icon } = look;
  const parent = parentOf(attachment.path);
  return (
    <span
      title={attachment.path}
      className="border-rule bg-paper-sunk text-ink flex min-w-0 max-w-64 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs"
    >
      <Icon size={12} strokeWidth={1.75} aria-hidden className={look.className} />
      <span className="min-w-0 truncate">
        {parent !== "" ? (
          <span className="text-faint">{parent}</span>
        ) : null}
        {basenameOf(attachment.path)}
      </span>
      {attachment.bytes !== undefined ? (
        <span className="text-faint shrink-0 font-mono text-[10px]">
          {formatBytes(attachment.bytes)}
        </span>
      ) : null}
      {attachment.source === "auto" ? (
        <span className="border-rule text-muted shrink-0 rounded-full border px-1 text-[10px] leading-4">
          auto
        </span>
      ) : null}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${attachment.path}`}
        className="text-muted hover:text-foreground shrink-0 transition-colors"
      >
        <X size={11} strokeWidth={1.75} aria-hidden />
      </button>
    </span>
  );
}

/**
 * The composer's attachment chips.
 *
 * Rendered inside the composer shell, above the input: `ApprovalPrompt` sits
 * above the shell and `ContextMeter` below the composer, so this is the one
 * place a row can grow without moving either.
 */
export function AttachmentBar() {
  const threadId = useChatStore((s) => s.activeThreadId ?? "");
  const items = useAttachmentStore((s) => s.items[threadId]);
  // Subscribed so the auto chip follows the File panel as the user opens files.
  useFileViewStore((s) => s.target);
  useFileViewStore((s) => s.authored);
  useAttachmentStore((s) => s.autoDisabled[threadId]);
  const remove = useAttachmentStore((s) => s.remove);
  const disableAuto = useAttachmentStore((s) => s.disableAuto);

  const manual = items ?? [];
  const auto = autoAttachmentForThread(threadId);
  const chips = auto === null ? manual : [...manual, auto];
  if (chips.length === 0) return null;

  return (
    <div
      data-slot="aui_composer-attachments"
      className="flex max-h-16 flex-wrap items-center gap-1.5 overflow-y-auto px-1"
    >
      {chips.map((attachment) => (
        <Chip
          key={attachment.id}
          attachment={attachment}
          onRemove={() =>
            attachment.source === "auto"
              ? disableAuto(threadId)
              : remove(threadId, attachment.id)
          }
        />
      ))}
    </div>
  );
}

/** What a sent turn's badge says the model actually got for each path. */
const MODE_LABELS: Record<AttachmentRecord["mode"], string> = {
  inline: "sent",
  image: "image",
  reference: "path only",
  unchanged: "unchanged",
  missing: "unreadable",
  denied: "no access",
};

/**
 * Attachment badges on a message already in the transcript.
 *
 * The content itself is filtered out of the bubble, so this is the only place
 * a reader learns what travelled with the turn — and the mode matters as much
 * as the name, since `path only` and `sent` are very different things to have
 * asked a model to look at.
 */
export function MessageAttachmentBadges({
  attachments,
}: {
  attachments: readonly AttachmentRecord[];
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {attachments.map((record) => {
        const look = fileLookFor(record.path);
        const { Icon } = look;
        const failed = record.mode === "missing" || record.mode === "denied";
        return (
          <span
            key={`${record.path}:${record.mode}`}
            title={`${record.path} — ${MODE_LABELS[record.mode]}`}
            className={`border-rule flex min-w-0 max-w-56 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${
              failed ? "text-muted" : "text-ink"
            } bg-paper-sunk`}
          >
            <Icon
              size={11}
              strokeWidth={1.75}
              aria-hidden
              className={look.className}
            />
            <span className="min-w-0 truncate">{basenameOf(record.path)}</span>
            <span className="text-faint shrink-0 font-mono text-[10px]">
              {MODE_LABELS[record.mode]}
            </span>
          </span>
        );
      })}
    </div>
  );
}
