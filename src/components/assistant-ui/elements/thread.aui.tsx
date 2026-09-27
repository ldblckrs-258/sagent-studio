"use client";

import { UserMessageAttachments } from "@/components/assistant-ui/elements/attachment.aui";
import { File } from "@/components/assistant-ui/elements/file";
import { ThreadFollowupSuggestions } from "@/components/assistant-ui/elements/follow-up-suggestions.aui";
import {
  Image,
  ImagePreview,
  ImageRoot,
  ImageZoom,
} from "@/components/assistant-ui/elements/image";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/components/assistant-ui/elements/reasoning.aui";
import { ToolCallView } from "@/components/assistant-ui/elements/tool-view/registry";
import {
  taskAwareGroupBy,
  threadGroupBy,
} from "@/components/assistant-ui/elements/tool-view/grouping";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import { SubAgentReport } from "@/components/assistant-ui/elements/sub-agent-report.aui";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/elements/tool-group.aui";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ApprovalPrompt } from "@/ui/approval-prompt";
import { AttachmentBar, MessageAttachmentBadges } from "@/ui/attachment-bar";
import { ComposerDropzone } from "@/ui/composer-dropzone";
import { ChatErrorBanner } from "@/ui/chat-error-banner";
import { attachmentsForQueueParts } from "@/chat/queue";
import { CompactionIndicator } from "@/ui/compaction-indicator";
import { ComposerControls } from "@/ui/composer-controls";
import { ContextMeter } from "@/ui/context-meter";
import type { AttachmentRecord } from "@/chat/attachments";
import type { AgentNoticeMeta, AgentNoticePart } from "@/chat/types";
import { ComposerHighlight } from "@/ui/composer-highlight";
import { UserBubble } from "@/ui/conversation";
import { MentionSuggestions } from "@/ui/mention-suggestions";
import { RewindButton, RewindDialog } from "@/ui/message-rewind";
import { SlashSuggestions } from "@/ui/slash-suggestions";
import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  QueueItemPrimitive,
  SuggestionPrimitive,
  ThreadPrimitive,
  useAssistantDataUI,
  useAuiState,
  type AssistantState,
  type DataMessagePartComponent,
  type FileMessagePartComponent,
  type ImageMessagePartComponent,
  type TextMessagePartComponent,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  AudioLinesIcon,
  BotIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  MicIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PhoneIcon,
  RefreshCwIcon,
  ScissorsIcon,
  SparklesIcon,
  SquareIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  XIcon,
} from "lucide-react";
import {
  createContext,
  useContext,
  useState,
  type ComponentType,
  type FC,
  type PropsWithChildren,
  type ReactNode,
} from "react";

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart;

/**
 * Optional component overrides for the thread. `AssistantMessage` and
 * `Welcome` replace whole sections; the remaining slots override how the
 * assistant message renders tool calls and part groups. Tool UIs registered
 * by name (toolkit `render`, `useAssistantDataUI`) take precedence over the
 * built-in views. Built-in tools render through their tailored view
 * (`tool-view/registry`), and a tool with none of those renders through
 * `ToolFallback`. When `TaskGroup` is set, tool calls that carry a nested
 * conversation and have no registered UI render through it instead of the
 * tool group; without it they render like any other tool call.
 */
export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined;
  Welcome?: ComponentType | undefined;
  ToolFallback?: ToolCallMessagePartComponent | undefined;
  ToolGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
  ReasoningGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined;
  TaskGroup?: ComponentType<{ group: ThreadGroupPart }> | undefined;
};

/**
 * The grouping policy lives in `tool-view/grouping`: tool calls are never
 * folded into a disclosure, so every call renders on its own in order. Only
 * reasoning coalesces.
 */
export type ThreadProps = {
  components?: ThreadComponents | undefined;
  autoFocus?: boolean | undefined;
};

const EMPTY_COMPONENTS: ThreadComponents = {};

const ThreadComponentsContext =
  createContext<ThreadComponents>(EMPTY_COMPONENTS);

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  (!s.thread.isLoading || s.threads.isLoading);

// A switched thread that is still fetching its history: skeleton, not welcome.
const isHistoryLoadingView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  s.thread.isLoading &&
  !s.thread.isDisabled &&
  !s.threads.isLoading;

const ThreadHistorySkeleton: FC = () => (
  <div
    data-slot="aui_thread-history-skeleton"
    role="status"
    className="animate-in fade-in fill-mode-both flex flex-col gap-y-6 [animation-delay:150ms] [animation-duration:200ms]"
  >
    <span className="sr-only">Loading conversation</span>
    <Skeleton className="ml-auto h-9 w-2/5 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-11/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-4/5 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-3/5 motion-reduce:animate-none" />
    </div>
    <Skeleton className="ml-auto h-9 w-1/3 rounded-xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-10/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
    </div>
  </div>
);

export const Thread: FC<ThreadProps> = ({
  components = EMPTY_COMPONENTS,
  autoFocus = true,
}) => {
  const isEmpty = useAuiState(isNewChatView);

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadRoot isEmpty={isEmpty} autoFocus={autoFocus} />
    </ThreadComponentsContext.Provider>
  );
};

const ThreadRoot: FC<{ isEmpty: boolean; autoFocus: boolean }> = ({
  isEmpty,
  autoFocus,
}) => {
  const { Welcome = ThreadWelcome } = useContext(ThreadComponentsContext);

  return (
    <ThreadShell
      isEmpty={isEmpty}
      lead={
        <>
          <AuiIf condition={isNewChatView}>
            <Welcome />
          </AuiIf>
          <AuiIf condition={isHistoryLoadingView}>
            <ThreadHistorySkeleton />
          </AuiIf>
        </>
      }
      afterMessages={<CompactionIndicator />}
      footer={
        <>
          <ThreadFollowupSuggestions />
          <ChatErrorBanner />
          <Composer autoFocus={autoFocus} />
          <ContextMeter />
          <AuiIf condition={(s) => isNewChatView(s) && s.composer.isEmpty}>
            <ThreadSuggestions />
          </AuiIf>
        </>
      }
    />
  );
};

export const ThreadShell: FC<{
  isEmpty?: boolean;
  lead?: ReactNode;
  afterMessages?: ReactNode;
  footer: ReactNode;
}> = ({ isEmpty = false, lead, afterMessages, footer }) => {
  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-background @container flex h-full flex-col"
      style={{
        ["--thread-max-width" as string]: "44rem",
        ["--composer-bg" as string]: "var(--color-surface)",
        ["--composer-radius" as string]: "1rem",
        ["--composer-padding" as string]: "8px",
      }}
    >
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        data-slot="aui_thread-viewport"
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth"
      >
        <div
          className={cn(
            "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4",
            isEmpty && "justify-center",
          )}
        >
          {lead}

          <div
            data-slot="aui_message-group"
            className="mb-14 flex flex-col gap-y-6 empty:hidden"
          >
            <ThreadPrimitive.Messages>
              {() => <ThreadMessage />}
            </ThreadPrimitive.Messages>
            {afterMessages}
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer bg-background flex flex-col gap-4 overflow-visible pb-4 md:pb-6",
              !isEmpty &&
                "sticky bottom-0 mt-auto rounded-t-(--composer-radius)",
            )}
          >
            <ThreadScrollToBottom />
            {footer}
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

/**
 * One message in the transcript, dispatched by role. Exported so a surface
 * outside the main thread (the Agents panel's run view) can render the same
 * conversation with its own runtime and get identical message bodies.
 */
export const ThreadMessage: FC = () => {
  const { AssistantMessage: AssistantMessageComponent = AssistantMessage } =
    useContext(ThreadComponentsContext);
  const role = useAuiState((s) => s.message.role);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);
  const isSpoken = useAuiState((s) => s.message.metadata.modality === "voice");
  const custom = useAuiState(
    (s) =>
      s.message.metadata.custom as
        | {
            skillDirective?: { name: string };
            compaction?: { replacedCount: number; error?: string };
            agentReport?: AgentNoticeMeta;
            agentNotice?: boolean;
            autoContinue?: { runId?: string; label?: string };
          }
        | undefined,
  );
  const skillDirective = custom?.skillDirective;
  const autoContinue = custom?.autoContinue;
  const compaction = custom?.compaction;
  // A standalone notice message is marked; an inline notice part instead rides
  // inside the assistant message and renders through `AssistantMessage`, so it
  // must not short-circuit the whole message here.
  const noticeState = useAuiState((s) => {
    const meta = s.message.metadata.custom as
      | { agentNotice?: boolean }
      | undefined;
    if (meta?.agentNotice !== true) return undefined;
    const notice = s.message.parts.find(
      (candidate) => candidate.type === "data" && candidate.name === "agent-notice",
    );
    if (notice?.type === "data") return notice.data as AgentNoticePart["data"];
    const text = s.message.parts.find((candidate) => candidate.type === "text");
    return text?.type === "text" ? text.text : "";
  });
  const noticeReport: AgentNoticeMeta | undefined =
    custom?.agentReport ??
    (noticeState === undefined
      ? undefined
      : typeof noticeState === "string"
        ? { status: "completed", response: noticeState }
        : noticeState);

  if (isEditing) return <EditComposer />;
  if (isSpoken) return <SpokenMessage />;
  if (skillDirective) return <SkillDirectiveMarker name={skillDirective.name} />;
  if (autoContinue) return <AutoContinueMarker label={autoContinue.label ?? autoContinue.runId} />;
  if (compaction)
    return <CompactionMarker replacedCount={compaction.replacedCount} error={compaction.error} />;
  if (noticeReport) return <SubAgentReport report={noticeReport} />;
  if (role === "user") return <UserMessage />;
  return <AssistantMessageComponent />;
};

/**
 * A compaction boundary. It is deliberately not an assistant bubble: that
 * would offer Regenerate, and regenerating it drops the boundary and silently
 * un-compacts the thread. The summary is still readable on demand, since it is
 * what the model now sees in place of the history above it.
 */
const CompactionMarker: FC<{ replacedCount: number; error?: string | undefined }> = ({
  replacedCount,
  error,
}) => {
  if (error !== undefined) {
    return (
      <p
        data-slot="aui_compaction-failed"
        className="border-caution-rule text-caution flex items-center gap-2 rounded-sm border border-dashed px-2.5 py-1.5 text-xs"
      >
        <ScissorsIcon size={12} strokeWidth={1.75} aria-hidden="true" />
        <span className="min-w-0 break-words">Compaction failed; the run continued uncompacted. {error}</span>
      </p>
    );
  }
  return (
    <details
      data-slot="aui_compaction-marker"
      className="border-rule text-muted group rounded-sm border border-dashed px-2.5 py-1.5 text-xs"
    >
      <summary className="hover:text-foreground flex cursor-pointer list-none items-center gap-2 transition-colors">
        <ScissorsIcon size={12} strokeWidth={1.75} aria-hidden="true" />
        <span>
          Compacted{" "}
          <span className="numeric font-mono">{replacedCount}</span>{" "}
          {replacedCount === 1 ? "message" : "messages"} into a summary
        </span>
        <span className="text-faint ml-auto text-[10px] group-open:hidden">
          show
        </span>
      </summary>
      <div className="border-rule text-ink mt-2 border-t pt-2">
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      </div>
    </details>
  );
};

/**
 * A skill invocation is a real message the model reads, but reading it adds
 * nothing for the user, so the transcript shows the fact of it on one line.
 */
const SkillDirectiveMarker: FC<{ name: string }> = ({ name }) => {
  return (
    <div
      data-slot="aui_skill-directive"
      className="text-muted flex items-center gap-2 text-xs"
    >
      <SparklesIcon size={12} strokeWidth={1.75} aria-hidden="true" />
      <span>
        Loaded skill <span className="font-mono text-ink">{name}</span>
      </span>
    </div>
  );
};

const AutoContinueMarker: FC<{ label?: string | undefined }> = ({ label }) => {
  return (
    <div data-slot="aui_auto-continue" className="text-muted flex items-center gap-2 text-xs">
      <BotIcon size={12} strokeWidth={1.75} aria-hidden="true" />
      <span>
        Continued automatically after sub-agent{" "}
        {label !== undefined ? <span className="font-mono text-ink">{label}</span> : null} finished
      </span>
    </div>
  );
};

type VoiceRunPosition = "single" | "start" | "middle" | "end";

const useVoiceRunPosition = (): VoiceRunPosition =>
  useAuiState((s) => {
    const before =
      s.thread.messages[s.message.index - 1]?.metadata.modality === "voice";
    const after =
      s.thread.messages[s.message.index + 1]?.metadata.modality === "voice";
    if (before) return after ? "middle" : "end";
    return after ? "start" : "single";
  });

const SpokenText: TextMessagePartComponent = ({ text }) => (
  <p className="aui-spoken-message-text m-0">{text}</p>
);

const SpokenMessage: FC = () => {
  const role = useAuiState((s) => s.message.role);
  const position = useVoiceRunPosition();
  const isSpeaking = useAuiState(
    (s) =>
      s.message.role === "assistant" && s.message.status?.type === "running",
  );
  const opensExchange = position === "start" || position === "single";

  return (
    <MessagePrimitive.Root
      data-slot="aui_spoken-message-root"
      data-role={role}
      data-voice-run={position}
      className={cn(
        "aui-spoken-message bg-paper-sunk/40 mx-2 px-3 py-1.5 [contain-intrinsic-size:auto_48px] [content-visibility:auto]",
        position === "single" && "rounded-xl py-2",
        position === "start" && "rounded-t-xl pt-2",
        position === "middle" && "-mt-6",
        position === "end" && "-mt-6 rounded-b-xl pb-2",
      )}
    >
      {opensExchange && (
        <div
          data-slot="aui_spoken-exchange-header"
          className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-xs"
        >
          <PhoneIcon className="size-3" aria-hidden />
          <span>Voice conversation</span>
        </div>
      )}
      <div
        data-slot="aui_spoken-message-content"
        className="text-foreground flex items-start gap-2 text-sm leading-relaxed"
      >
        <span className="text-muted-foreground mt-1 shrink-0" aria-hidden>
          {role === "user" ? (
            <MicIcon className="size-3.5" />
          ) : (
            <AudioLinesIcon className="size-3.5" />
          )}
        </span>
        <span className="sr-only">
          {role === "user" ? "You said" : "Assistant said"}
        </span>
        <div className="min-w-0 flex-1 wrap-break-word">
          <MessagePrimitive.Parts components={{ Text: SpokenText }} />
          {isSpeaking && (
            <span
              data-slot="aui_spoken-message-indicator"
              role="status"
              className="text-muted-foreground ms-1 animate-pulse font-sans"
              aria-label="Assistant is speaking"
            >
              ●
            </span>
          )}
        </div>
        <SpokenActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const SpokenActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="always"
      className="aui-spoken-action-bar text-muted-foreground flex shrink-0 gap-1"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy" className="size-6">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  );
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        className="aui-thread-scroll-to-bottom dark:border-border dark:bg-background dark:hover:bg-accent-soft absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC = () => {
  return (
    <div className="aui-thread-welcome-root mb-6 flex flex-col px-2">
      <p className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-medium tracking-tight duration-200">
        How can I help you today?
      </p>
    </div>
  );
};

const ThreadSuggestions: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestions flex w-full flex-col">
      <ThreadPrimitive.Suggestions>
        {() => <ThreadSuggestionItem />}
      </ThreadPrimitive.Suggestions>
    </div>
  );
};

const ThreadSuggestionItem: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestion-display fade-in slide-in-from-bottom-2 animate-in fill-mode-both duration-200">
      <SuggestionPrimitive.Trigger send asChild>
        <button
          type="button"
          className="aui-thread-welcome-suggestion group hover:bg-foreground/[0.03] focus-visible:ring-ring/50 flex w-full items-baseline gap-2.5 rounded-md px-2 py-2 text-start text-sm transition-colors outline-none focus-visible:ring-1 motion-reduce:transition-none"
        >
          <span
            aria-hidden
            className="text-muted-foreground/60 group-hover:text-foreground font-mono text-xs transition-colors motion-reduce:transition-none"
          >
            {">"}
          </span>
          <span className="min-w-0 flex-1 truncate">
            <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1 text-foreground" />{" "}
            <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 text-muted-foreground empty:hidden" />
          </span>
        </button>
      </SuggestionPrimitive.Trigger>
    </div>
  );
};

const Composer: FC<{ autoFocus: boolean }> = ({ autoFocus }) => {
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <ApprovalPrompt />
      <ComposerDropzone>
          <AttachmentBar />
          <SlashSuggestions>
            <MentionSuggestions>
            <ComposerHighlight>
            <ComposerPrimitive.Input
              placeholder="Send a message..."
              // Transparent glyphs: `ComposerHighlight` paints the text under
              // the textarea so a completed command and an attached mention can
              // carry their own colour. The caret, the selection, and the
              // placeholder keep their own colours and stay visible.
              className="aui-composer-input caret-primary selection:text-ink text-transparent placeholder:text-muted-foreground/60 max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base leading-6 outline-none"
              rows={1}
              autoFocus={autoFocus}
              enterKeyHint="send"
              aria-label="Message input"
            />
            </ComposerHighlight>
            </MentionSuggestions>
          </SlashSuggestions>
          <div className="flex items-center justify-between gap-2">
            <ComposerControls />
            <ComposerAction />
          </div>
      </ComposerDropzone>
      <ComposerQueue />
    </ComposerPrimitive.Root>
  );
};

/**
 * What a queued message will attach when it drains. Without it a queued row
 * shows its text alone, and the chips it captured are invisible until the
 * message sends.
 */
const QueuedAttachmentCount: FC = () => {
  const count = useAuiState(
    (s) => attachmentsForQueueParts(s.queueItem.parts ?? []).length,
  );
  if (count === 0) return null;
  return (
    <span className="text-faint shrink-0 font-mono text-[10px]">
      {count} attached
    </span>
  );
};

/**
 * Messages typed during a run. They wait here in order and dispatch when the
 * run settles; removing one drops it without touching the run.
 */
const ComposerQueue: FC = () => {
  return (
    <div
      data-slot="aui_composer-queue"
      className="mt-1.5 flex flex-col gap-1 empty:hidden"
    >
      <ComposerPrimitive.Queue>
        {() => (
          <div className="border-rule bg-paper-sunk text-muted flex items-center gap-2 rounded-sm border px-2 py-1 text-xs">
            <span className="text-faint shrink-0 font-mono text-[10px]">
              queued
            </span>
            <QueueItemPrimitive.Text className="min-w-0 flex-1 truncate" />
            <QueuedAttachmentCount />
            <QueueItemPrimitive.Remove asChild>
              <button
                type="button"
                aria-label="Remove queued message"
                className="hover:text-foreground shrink-0 transition-colors"
              >
                <XIcon size={12} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </QueueItemPrimitive.Remove>
          </div>
        )}
      </ComposerPrimitive.Queue>
    </div>
  );
};

const ComposerAction: FC = () => {
  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-end">
      <div className="flex items-center gap-1.5">
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate asChild>
              <TooltipIconButton
                tooltip="Voice input"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-dictate text-muted-foreground hover:text-foreground size-7 rounded-full"
                aria-label="Start voice input"
              >
                <MicIcon className="aui-composer-dictate-icon size-4" />
              </TooltipIconButton>
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation asChild>
              <TooltipIconButton
                tooltip="Stop dictation"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="aui-composer-stop-dictation text-destructive size-7 rounded-full"
                aria-label="Stop voice input"
              >
                <SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current" />
              </TooltipIconButton>
            </ComposerPrimitive.StopDictation>
          </AuiIf>
        </AuiIf>
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerSendButton />
        </AuiIf>
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerCancelButton />
        </AuiIf>
      </div>
    </div>
  );
};

export const ComposerSendButton: FC<{ tooltip?: string; label?: string }> = ({
  tooltip = "Send message",
  label = "Send message",
}) => (
  <ComposerPrimitive.Send asChild>
    <TooltipIconButton
      tooltip={tooltip}
      side="bottom"
      type="button"
      variant="default"
      size="icon"
      className="aui-composer-send size-7 rounded-full"
      aria-label={label}
    >
      <ArrowUpIcon className="aui-composer-send-icon size-4" />
    </TooltipIconButton>
  </ComposerPrimitive.Send>
);

export const ComposerCancelButton: FC<{ label?: string }> = ({
  label = "Stop generating",
}) => (
  <ComposerPrimitive.Cancel asChild>
    <Button
      type="button"
      variant="default"
      size="icon"
      className="aui-composer-cancel size-7 rounded-full"
      aria-label={label}
    >
      <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
    </Button>
  </ComposerPrimitive.Cancel>
);

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root border-destructive bg-destructive/10 text-destructive dark:bg-destructive/5 mt-2 rounded-md border p-3 text-sm dark:text-red-200">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
        <ActionBarPrimitive.Reload asChild>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="aui-message-error-retry mt-2"
          >
            <RefreshCwIcon />
            Retry
          </Button>
        </ActionBarPrimitive.Reload>
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const AgentNoticeCard: DataMessagePartComponent<AgentNoticePart["data"]> = ({
  data,
}) => <SubAgentReport report={data} />;

const AssistantMessage: FC = () => {
  const {
    ToolFallback: ToolFallbackComponent = ToolFallback,
    ToolGroup,
    ReasoningGroup,
    TaskGroup: TaskGroupComponent,
  } = useContext(ThreadComponentsContext);
  const groupBy = TaskGroupComponent ? taskAwareGroupBy : threadGroupBy;

  // An `agent-notice` data part renders the sub-agent card in place, so a
  // background report interrupts the streaming turn exactly where it arrived.
  useAssistantDataUI({ name: "agent-notice", render: AgentNoticeCard });

  const ACTION_BAR_PT = "pt-1.5";
  // Keep the action bar inside the contained root's paint box, then cancel its reserved space in flow.
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`;

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="fade-in slide-in-from-bottom-1 animate-in relative -mb-7.5 pb-7.5 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <div
        data-slot="aui_assistant-message-content"
        className="text-foreground px-2 leading-relaxed wrap-break-word"
      >
        <MessagePrimitive.GroupedParts groupBy={groupBy}>
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                return <div data-slot="aui_chain-of-thought">{children}</div>;
              case "group-task":
                return TaskGroupComponent ? (
                  <TaskGroupComponent group={part} />
                ) : null;
              case "group-tool":
                if (ToolGroup) {
                  return <ToolGroup group={part}>{children}</ToolGroup>;
                }
                return (
                  <ToolGroupRoot variant="ghost">
                    <ToolGroupTrigger
                      count={part.indices.length}
                      active={part.status.type === "running"}
                    />
                    <ToolGroupContent>{children}</ToolGroupContent>
                  </ToolGroupRoot>
                );
              case "group-reasoning": {
                if (ReasoningGroup) {
                  return (
                    <ReasoningGroup group={part}>{children}</ReasoningGroup>
                  );
                }
                const running = part.status.type === "running";
                return (
                  <ReasoningRoot streaming={running} variant="ghost">
                    <ReasoningTrigger active={running} />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case "text":
                return <MarkdownText />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call":
                return part.toolUI ?? (
                  <ToolCallView {...part} fallback={ToolFallbackComponent} />
                );
              case "data":
                return part.dataRendererUI;
              case "file":
                return (
                  <div data-slot="aui_assistant-message-file" className="py-1">
                    <File {...part} />
                  </div>
                );
              case "image":
                return (
                  <div data-slot="aui_assistant-message-image" className="py-1">
                    <Image {...part} />
                  </div>
                );
              case "indicator":
                return (
                  <span
                    data-slot="aui_assistant-message-indicator"
                    className="animate-pulse font-sans"
                    aria-label="Assistant is working"
                  >
                    {"●"}
                  </span>
                );
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
      >
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root text-muted-foreground animate-in fade-in col-start-3 row-start-2 -ms-1 flex gap-1 duration-200"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy">
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in zoom-in-50 fade-in duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in zoom-in-75 fade-in duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <AuiIf condition={(s) => s.thread.capabilities.feedback}>
        <ActionBarPrimitive.FeedbackPositive asChild>
          <TooltipIconButton
            tooltip="Helpful"
            className="data-[submitted=true]:bg-accent-soft data-[submitted=true]:text-ink"
          >
            <ThumbsUpIcon />
          </TooltipIconButton>
        </ActionBarPrimitive.FeedbackPositive>
        <ActionBarPrimitive.FeedbackNegative asChild>
          <TooltipIconButton
            tooltip="Not helpful"
            className="data-[submitted=true]:bg-accent-soft data-[submitted=true]:text-ink"
          >
            <ThumbsDownIcon />
          </TooltipIconButton>
        </ActionBarPrimitive.FeedbackNegative>
      </AuiIf>
      <AuiIf condition={(s) => s.thread.capabilities.reload}>
        <ActionBarPrimitive.Reload asChild>
          <TooltipIconButton tooltip="Refresh">
            <RefreshCwIcon />
          </TooltipIconButton>
        </ActionBarPrimitive.Reload>
      </AuiIf>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton
            tooltip="More"
            className="data-[state=open]:bg-accent-soft"
          >
            <MoreHorizontalIcon />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:animate-out data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-xl border p-1.5"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item hover:bg-accent-soft hover:text-ink focus:bg-accent-soft focus:text-ink flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none">
              <DownloadIcon className="size-4" />
              Export as Markdown
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
};

const UserFilePart: FileMessagePartComponent = (part) =>
  // An image has its own place above the bubble; the file card would repeat
  // the filename over a picture already on screen.
  part.mimeType.startsWith("image/") ? null : (
    <div data-slot="aui_user-message-file" className="py-1">
      <File {...part} />
    </div>
  );

const UserImagePart: ImageMessagePartComponent = () => null;

/**
 * User image attachments, drawn above the bubble.
 *
 * The image file part is suppressed from `MessagePrimitive.Parts`, and the
 * `mode: "image"` badge is suppressed too, so the picture itself is the only
 * thing shown. A marker-only image (`reference`/`missing`) has no file part and
 * therefore still surfaces as a badge.
 */
const UserMessageImages: FC = () => {
  const parts = useAuiState((s) => s.message.parts);
  const images = parts.flatMap((part) => {
    if (part.type === "file" && part.mimeType.startsWith("image/")) {
      return [{ src: part.data, filename: part.filename }];
    }
    if (part.type === "image") {
      return [{ src: part.image, filename: part.filename }];
    }
    return [];
  });
  if (images.length === 0) return null;
  return (
    <div className="col-start-2 flex flex-wrap justify-end gap-2">
      {images.map((image, index) => {
        const alt = image.filename ?? "Attached image";
        return (
          <ImageRoot key={`${alt}:${index}`} size="sm">
            <ImageZoom src={image.src} alt={alt}>
              <ImagePreview src={image.src} alt={alt} />
            </ImageZoom>
          </ImageRoot>
        );
      })}
    </div>
  );
};

const UserMessage: FC = () => {
  const [rewinding, setRewinding] = useState(false);
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="fade-in slide-in-from-bottom-1 animate-in grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageAttachments />
      <UserMessageImages />
      <UserAttachmentBadges />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <UserBubble className="aui-user-message-content peer empty:hidden">
          <MessagePrimitive.Parts
            components={{ File: UserFilePart, Image: UserImagePart }}
          />
        </UserBubble>
        <div
          data-slot="aui_user-message-footer"
          className="flex min-h-7.5 justify-end pt-1.5 peer-empty:hidden"
        >
          <UserActionBar onRewind={() => setRewinding(true)} />
        </div>
      </div>
      {rewinding ? <RewindDialog onClose={() => setRewinding(false)} /> : null}
    </MessagePrimitive.Root>
  );
};

/** Reads what `toThreadMessageLike` carried over for this turn. */
const UserAttachmentBadges: FC = () => {
  const attachments = useAuiState(
    (s) =>
      (
        s.message.metadata.custom as
          | { attachments?: readonly AttachmentRecord[] }
          | undefined
      )?.attachments,
  );
  // An image attachment is shown as the picture itself above the bubble, so a
  // badge that only says "image" would be a duplicate.
  const visible = attachments?.filter((record) => record.mode !== "image");
  if (!visible || visible.length === 0) return null;
  return (
    <div className="col-start-2">
      <MessageAttachmentBadges attachments={visible} />
    </div>
  );
};

const UserActionBar: FC<{ onRewind: () => void }> = ({ onRewind }) => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root text-muted-foreground animate-in fade-in -me-1 flex gap-1 duration-200"
    >
      <AuiIf condition={(s) => s.thread.capabilities.edit}>
        <ActionBarPrimitive.Edit asChild>
          <TooltipIconButton tooltip="Edit" className="aui-user-action-edit">
            <PencilIcon />
          </TooltipIconButton>
        </ActionBarPrimitive.Edit>
      </AuiIf>
      <RewindButton onSelect={onRewind} />
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root border-foreground/10 focus-within:border-foreground/25 ms-auto flex w-full max-w-[85%] cursor-text flex-col rounded-(--composer-radius) border bg-(--composer-bg) transition-[border-color]">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input text-foreground min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm" className="h-8 px-3">
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm" className="h-8 px-3">
              Update
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};
