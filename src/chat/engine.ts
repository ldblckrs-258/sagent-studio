import type {
  LanguageModel,
  LanguageModelUsage,
  UIMessage,
  UIMessageChunk,
} from "ai";
import {
  convertToModelMessages,
  readUIMessageStream,
  streamText,
  toUIMessageStream,
} from "ai";
import { createLLM } from "../ai/llm";
import type { ResolvedAttachments } from "./attachments";
import {
  applyUnchanged,
  attachmentParts,
  attachmentRecords,
  seenPaths,
} from "./attachments";
import type { RagPort } from "../rag/port";
import type { CodeRunner } from "../sandbox/types";
import type { WorkspaceJournal } from "../workspace/journal";
import type { SkillRegistry } from "../skills/registry";
import type { AgentParentContext } from "../agents/types";
import { createAdminPorts } from "../tools/admin-ports";
import type { ToolRegistry } from "../tools/registry";
import { redactSecrets } from "../tools/redact";
import { resolveRunToolNames } from "../tools/selection";
import { decisionFor } from "../tools/approval";
import type { ToolGateDescriptor } from "../tools/approval";
import type {
  AgentSpawnPort,
  SandboxControlPort,
  SkillLoadPort,
  ThreadModePort,
  ThreadPlanPort,
  PreviewPort,
  WorkspaceApi,
} from "../tools/types";
import { VaultLockedError } from "../vault/errors";
import type { ApprovalDecision, Settings } from "../vault/settings";
import { useVaultStore } from "../vault/store";
import { createToolApproval } from "./approval";
import { isAutomaticApproval } from "./approval-pending";
import {
  compactThread,
  messagesSinceBoundary,
  splitTrailingUserTurn,
} from "./compact";
import { clampIndexText, composeSystemPrompt } from "./context";
import { resolveContextCap, shouldAutoCompact } from "./context-cap";
import type { ProjectInstruction, ResolvedSkill } from "./context";
import { ChatError, ChatThreadNotFoundError } from "./errors";
import type { ThreadSummary } from "./persistence";
import {
  appendMessage,
  baseForMessage,
  canRerun,
  canUndo,
  editMessage as editMessages,
  undoLastTurn,
} from "./reducer";
import { expireApprovals, rehydrateThread, sanitizePartial, setChatStatus } from "./sanitize";
import { registerAbortAll, useChatStore } from "./store";
import { contextTokensOf, outputCharsOf, turnUsageFrom } from "./usage";
import { normalizeTitle, patchThreadMode } from "./threads";
import { countUserMessages, generateConversationTitle, shouldGenerateTitle } from "./title";
import { convertAgentNoticePart, isAgentNoticePart } from "./types";
import type {
  AgentNoticeMeta,
  AgentNoticePart,
  AgentNoticeReport,
  ChatMode,
  ChatThread,
  ThreadConfig,
} from "./types";

export interface PipelineDeps {
  getSettings(): Settings | null;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  rag?: RagPort;
  workspace?: WorkspaceApi;
  codeRunner?: CodeRunner;
  sandbox?: SandboxControlPort;
  preview?: PreviewPort;
  /** The conversation's journal, loaded lazily so a run always records into its own. */
  journalFor?(threadId: string): Promise<WorkspaceJournal>;
  /** Persists an `allow-always` decision. Defaults to the encrypted vault. */
  persistApproval?(
    toolName: string,
    decision: ApprovalDecision,
  ): Promise<void>;
  modelFactory?(
    settings: Settings,
    providerId: string,
    modelId?: string,
  ): LanguageModel;
  /**
   * Built before the toolset exists so `spawn_agent` is available; the context's
   * `toolNames` is filled in afterward with the final parent tool names.
   */
  agentPortsFor?(context: AgentParentContext): AgentSpawnPort | undefined;
}

export interface ApprovalResponse {
  approvalId: string;
  approved: boolean;
  optionId?: string;
  reason?: string;
}

export interface ThreadStore {
  loadThread(id: string): Promise<ChatThread | null>;
  saveThread(thread: ChatThread): Promise<void>;
  listThreads(): Promise<ThreadSummary[]>;
  deleteThread(id: string): Promise<void>;
}

export interface EngineDeps extends PipelineDeps {
  threadStore: ThreadStore;
}

export interface SendTurnExtra {
  /** Already-resolved attachments; suppression is applied inside `sendTurn`. */
  attachments?: ResolvedAttachments;
}

export interface ChatEngine {
  sendTurn(threadId: string, text: string, extra?: SendTurnExtra): Promise<void>;
  editMessage(
    threadId: string,
    messageId: string,
    parts: UIMessage["parts"],
  ): Promise<void>;
  rerun(threadId: string, messageId: string): Promise<void>;
  undo(threadId: string): Promise<void>;
  respondToApproval(threadId: string, response: ApprovalResponse): Promise<void>;
  /**
   * Compacts on demand. It lives on the engine rather than beside its caller
   * because the engine owns the provider deps and the thread-write path, and a
   * second writer would fork persistence.
   */
  compact(threadId: string, instructions?: string): Promise<void>;
  cancel(threadId: string): Promise<void>;
  /**
   * Appends a background-agent notice immediately. When the thread's run is
   * still streaming, the notice is appended inline to that assistant message at
   * the point it arrived and is preserved across the remaining chunks; when the
   * thread is idle, it is written as a standalone notice message. The optional
   * `report` carries the run's identity and response so the transcript can
   * render the notice as a sub-agent card; the `text` stays the model-visible
   * framing.
   */
  appendAgentNotice(
    threadId: string,
    text: string,
    runId?: string,
    report?: AgentNoticeReport,
  ): void;
  /** Unregisters the global abort callback and aborts any in-flight runs. */
  dispose(): void;
}

export interface BuiltRun {
  stream: ReadableStream<UIMessageChunk>;
  toolNames: string[];
}

/**
 * Provider retries before the response body begins. Safe with side-effecting
 * tools because no tool can run until the stream starts; mid-stream failures
 * are left to the user's inline retry instead of re-running a model step that
 * may already have executed tools.
 */
const MODEL_MAX_RETRIES = 3;

export { redactSecrets };

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * A run failure's message. A stream error arrives as an `Error` whose message
 * was already formatted and redacted by `toUIMessageStream`'s `onError`, so this
 * reads `.message` directly instead of double-prefixing the error name.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function createMessageId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface PendingApproval {
  messageId: string;
  messageIndex: number;
  partIndex: number;
  approvalId: string;
  toolName: string;
  approval: Record<string, unknown>;
}

function toolNameOf(part: Record<string, unknown>): string {
  const type = part.type;
  if (typeof type === "string" && type.startsWith("tool-")) {
    return type.slice("tool-".length);
  }
  return typeof part.toolName === "string" ? part.toolName : "";
}

/**
 * A stable identity for a notice part, used to keep an injected notice from
 * being added twice when the streaming loop re-merges it. A run id is the
 * natural key; a run without one falls back to its payload, which is the best
 * available identity.
 */
function noticeKeyOf(part: UIMessage["parts"][number]): string | undefined {
  if (!isAgentNoticePart(part)) return undefined;
  const { runId, text, status, response } = part.data;
  if (runId !== undefined && runId.length > 0) return `run:${runId}`;
  return `notice:${text}\u0000${status}\u0000${response}`;
}

/**
 * Re-attaches any notice parts injected into the message while it streamed.
 * The streamed reconstruction replaces the message's parts, so without this a
 * notice appended mid-run would be dropped by the next chunk.
 */
function mergeNoticeParts(
  streamed: UIMessage,
  current: UIMessage | undefined,
): UIMessage {
  if (!current) return streamed;
  const seen = new Set<string>();
  for (const part of streamed.parts) {
    const key = noticeKeyOf(part);
    if (key !== undefined) seen.add(key);
  }
  const kept: UIMessage["parts"] = [];
  for (const part of current.parts) {
    const key = noticeKeyOf(part);
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    kept.push(part);
  }
  if (kept.length === 0) return streamed;
  return { ...streamed, parts: [...streamed.parts, ...kept] };
}

function collectPendingApprovals(messages: UIMessage[]): PendingApproval[] {
  const pending: PendingApproval[] = [];
  messages.forEach((message, messageIndex) => {
    if (message.role !== "assistant") return;
    message.parts.forEach((part, partIndex) => {
      const record = part as unknown as Record<string, unknown>;
      if (record.state !== "approval-requested") return;
      const approval = record.approval as { id?: unknown } | undefined;
      if (!approval || typeof approval.id !== "string") return;
      // An automatic (statically approved/denied) or expired request is not the
      // user's to answer; only a real request may be resumed or expired.
      if (isAutomaticApproval(approval)) return;
      pending.push({
        messageId: message.id,
        messageIndex,
        partIndex,
        approvalId: approval.id,
        toolName: toolNameOf(record),
        approval: approval as Record<string, unknown>,
      });
    });
  });
  return pending;
}

export function createSkillLoadPort(skills: readonly ResolvedSkill[]): SkillLoadPort {
  const describe = (skill: ResolvedSkill) => ({
    id: skill.id,
    name: skill.source === "workspace" ? clampIndexText(skill.name) : skill.name,
    description:
      skill.source === "workspace" ? clampIndexText(skill.description) : skill.description,
    source: skill.source,
  })
  return {
    list: () => skills.map(describe),
    load: (id, source) => {
      const skill = skills.find(
        (entry) => entry.id === id && (source === undefined || entry.source === source),
      )
      return skill ? { ...describe(skill), instructions: skill.instructions } : null
    },
  }
}

const PROJECT_INSTRUCTION_CANDIDATES = ["AGENTS.md", "README.md"];
const MAX_PROJECT_INSTRUCTION_CHARS = 8000;

/**
 * Loads the workspace's own instruction file so a fresh session is primed with
 * project conventions instead of inventing them. Returns null when the
 * workspace has none, which the prompt renders as an explicit "none found".
 */
async function loadProjectInstruction(
  workspace: WorkspaceApi | undefined,
): Promise<ProjectInstruction | null> {
  if (!workspace) return null;
  for (const path of PROJECT_INSTRUCTION_CANDIDATES) {
    try {
      const text = await workspace.readFile(path);
      if (text.trim().length === 0) continue;
      return {
        path,
        text:
          text.length > MAX_PROJECT_INSTRUCTION_CHARS
            ? text.slice(0, MAX_PROJECT_INSTRUCTION_CHARS)
            : text,
      };
    } catch {
      continue;
    }
  }
  return null;
}

function isFailedAssistantMessage(message: UIMessage): boolean {
  if (message.role !== "assistant") return false;
  const metadata = message.metadata as
    | { error?: unknown; chatStatus?: unknown }
    | undefined;
  return (
    (typeof metadata?.error === "string" && metadata.error.length > 0) ||
    metadata?.chatStatus === "error"
  );
}

/** Clears a prior run error so a resume streams cleanly instead of re-rendering it. */
function clearRunError(message: UIMessage): UIMessage {
  const metadata = { ...((message.metadata as Record<string, unknown> | undefined) ?? {}) };
  delete metadata.error;
  return { ...message, metadata: { ...metadata, chatStatus: "streaming" } };
}

async function defaultPersistApproval(
  toolName: string,
  decision: ApprovalDecision,
): Promise<void> {
  await useVaultStore.getState().update({
    approvals: { tools: { [toolName]: decision } },
  });
}

export async function buildRunStream(
  deps: PipelineDeps,
  config: ThreadConfig,
  messages: UIMessage[],
  signal: AbortSignal,
  generateMessageId: () => string,
  mode: ChatMode = "editing",
  modePort?: ThreadModePort,
  planPort?: ThreadPlanPort,
  journal?: WorkspaceJournal,
  agentContext?: AgentParentContext,
): Promise<BuiltRun> {
  const settings = deps.getSettings();
  if (!settings)
    throw new ChatError("The vault is locked; the chat cannot run.");

  const skills = deps.skillRegistry.resolve(config.enabledSkills);
  const agents = agentContext ? deps.agentPortsFor?.(agentContext) : undefined;
  const ports = {
    rag: deps.rag,
    workspace: deps.workspace,
    codeRunner: deps.codeRunner,
    sandbox: deps.sandbox,
    preview: deps.preview,
    mode: modePort,
    skills: createSkillLoadPort(skills),
    plan: planPort,
    journal,
    ...(agents ? { agents } : {}),
    approvals: {
      decision: (toolName: string) => decisionFor(settings.approvals, toolName),
    },
    ...createAdminPorts({
      skillRegistry: deps.skillRegistry,
      toolRegistry: deps.toolRegistry,
    }),
  };
  // The parent passes no pool (every available tool) and no block list, so this
  // shares one resolver with a delegated agent that narrows and blocks.
  const requestedTools = resolveRunToolNames({
    toolRegistry: deps.toolRegistry,
    skillRegistry: deps.skillRegistry,
    ports,
    enabledSkills: config.enabledSkills,
    resolvedSkills: skills,
    blocked: [],
  });
  const toolSet = deps.toolRegistry.buildToolSet(requestedTools, ports);
  // Fill the parent context now that the final toolset exists; a delegated
  // agent may only draw from these names.
  if (agentContext) agentContext.toolNames = Object.keys(toolSet);
  const projectInstruction = await loadProjectInstruction(deps.workspace);
  const system = composeSystemPrompt(
    config.systemInstruction,
    skills,
    Object.keys(toolSet),
    {
      mode,
      ...(deps.workspace ? { projectInstruction } : {}),
    },
  );

  const gateTools: ToolGateDescriptor[] = Object.keys(toolSet).map((name) => {
    const kind = deps.toolRegistry.userToolKind(name);
    return kind ? { name, kind } : { name };
  });
  const toolApproval = createToolApproval(mode, settings.approvals, gateTools);

  const modelFactory = deps.modelFactory ?? createLLM;
  const model = modelFactory(settings, config.providerId, config.modelId);
  // Only the window since the newest compaction boundary is sent. The stored
  // array stays whole, which is what keeps a compaction reversible and the UI
  // transcript complete; `originalMessages` below still needs all of it.
  const modelMessages = await convertToModelMessages(
    messagesSinceBoundary(messages),
    {
      tools: toolSet,
      ignoreIncompleteToolCalls: true,
      convertDataPart: convertAgentNoticePart,
    },
  );

  const result = streamText({
    model,
    system,
    messages: modelMessages,
    tools: toolSet,
    toolApproval,
    maxRetries: MODEL_MAX_RETRIES,
    stopWhen: () => false,
    abortSignal: signal,
    ...config.params,
    ...(config.providerOptions
      ? {
          providerOptions: config.providerOptions as NonNullable<
            Parameters<typeof streamText>[0]["providerOptions"]
          >,
        }
      : {}),
  });

  // `start` fires once per turn and `finish-step` once per model step, so the
  // turn's span is measured from the former and the conversation's real size
  // read from the latter. `finish.totalUsage.inputTokens` cannot serve: it sums
  // every step's prompt, which counts the same conversation once per tool call.
  // Returning undefined except on `finish` leaves the placeholder's metadata
  // (and its `chatStatus`) untouched.
  let streamStartedAt = Date.now();
  let lastStepUsage: LanguageModelUsage | undefined;
  const stream = toUIMessageStream({
    stream: result.stream,
    tools: toolSet,
    originalMessages: messages,
    generateMessageId,
    messageMetadata: ({ part }) => {
      if (part.type === "start") {
        streamStartedAt = Date.now();
        return undefined;
      }
      if (part.type === "finish-step") {
        lastStepUsage = part.usage;
        return undefined;
      }
      if (part.type !== "finish") return undefined;
      return {
        usage: turnUsageFrom(
          part.totalUsage,
          Date.now() - streamStartedAt,
          lastStepUsage,
        ),
      };
    },
    // Preserve the provider's own message (redacted) instead of the SDK's
    // generic "An error occurred.", so the inline error is actionable.
    onError: (error) => redactSecrets(describe(error)),
  });

  return { stream, toolNames: Object.keys(toolSet) };
}

class DefaultEngine implements ChatEngine {
  private readonly deps: EngineDeps;
  private readonly controllers = new Map<string, AbortController>();
  private readonly runs = new Map<string, Promise<void>>();
  private readonly unregisterAbort: () => void;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.unregisterAbort = registerAbortAll(() => {
      for (const controller of this.controllers.values()) controller.abort();
    });
  }

  dispose(): void {
    this.unregisterAbort();
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.runs.clear();
  }

  async sendTurn(
    threadId: string,
    text: string,
    extra: SendTurnExtra = {},
  ): Promise<void> {
    const thread = await this.requireThread(threadId);
    // Suppression is decided here, against the messages this run starts from,
    // and covers both an earlier attachment and the model's own `read_file`.
    // Auto-compaction can still bury the content inside the same run, which is
    // why the `unchanged` marker also tells the model how to recover it.
    const resolved =
      extra.attachments === undefined
        ? undefined
        : applyUnchanged(extra.attachments, seenPaths(thread.messages));
    const records = resolved === undefined ? [] : attachmentRecords(resolved);
    const userMessage: UIMessage = {
      id: createMessageId(),
      role: "user",
      parts: [
        ...(resolved === undefined ? [] : attachmentParts(resolved)),
        { type: "text", text },
      ],
      ...(records.length > 0 ? { metadata: { attachments: records } } : {}),
    };
    await this.startRun(threadId, appendMessage(thread.messages, userMessage));
  }

  async editMessage(
    threadId: string,
    messageId: string,
    parts: UIMessage["parts"],
  ): Promise<void> {
    const thread = await this.requireThread(threadId);
    const target = thread.messages.find((message) => message.id === messageId);
    if (!target) return;

    const edited = editMessages(thread.messages, messageId, parts);
    this.setThreadMessages(threadId, edited);
    await this.persist(threadId);
    if (target.role === "user") await this.startRun(threadId, edited);
  }

  async rerun(threadId: string, messageId: string): Promise<void> {
    const thread = await this.requireThread(threadId);
    if (!canRerun(thread.messages, messageId)) return;
    const index = thread.messages.findIndex((message) => message.id === messageId);
    const target = index === -1 ? undefined : thread.messages[index];
    // Retrying a failed final turn resumes it: the assistant message already
    // holds the completed tool calls and their results, so continuing from it
    // avoids replaying (and re-running) every tool the turn had already done.
    // Regenerating a healthy turn, or an older message, still starts fresh.
    if (
      target !== undefined &&
      isFailedAssistantMessage(target) &&
      index === thread.messages.length - 1
    ) {
      const resumed = thread.messages.map((message) =>
        message.id === messageId ? clearRunError(message) : message,
      );
      await this.startRun(threadId, resumed, { resumeAssistantId: messageId });
      return;
    }
    const base = baseForMessage(thread.messages, messageId);
    this.setThreadMessages(threadId, base);
    await this.persist(threadId);
    await this.startRun(threadId, base);
  }

  async undo(threadId: string): Promise<void> {
    const thread = await this.requireThread(threadId);
    if (!canUndo(thread.messages)) return;
    this.setThreadMessages(threadId, undoLastTurn(thread.messages));
    await this.persist(threadId);
  }

  async respondToApproval(
    threadId: string,
    response: ApprovalResponse,
  ): Promise<void> {
    const thread = await this.requireThread(threadId);
    const pending = collectPendingApprovals(thread.messages);
    const target = pending.find((entry) => entry.approvalId === response.approvalId);
    if (!target) return;

    const isLatest = pending[pending.length - 1] === target;
    const isLastMessage = target.messageIndex === thread.messages.length - 1;
    if (!isLatest || !isLastMessage) {
      const messages = thread.messages.map((message, index) =>
        index === target.messageIndex ? expireApprovals(message) : message,
      );
      this.setThreadMessages(threadId, messages);
      await this.persist(threadId);
      return;
    }

    if (response.optionId === "allow-always" && target.toolName !== "change_mode") {
      const persist = this.deps.persistApproval ?? defaultPersistApproval;
      await persist(target.toolName, "allow");
    }

    const messages = thread.messages.map((message, index) =>
      index === target.messageIndex
        ? {
            ...message,
            parts: message.parts.map((part, partIndex) =>
              partIndex === target.partIndex
                ? ({
                    ...part,
                    state: "approval-responded",
                    approval: {
                      ...target.approval,
                      approved: response.approved,
                      ...(response.optionId !== undefined
                        ? { optionId: response.optionId }
                        : {}),
                      ...(response.reason !== undefined
                        ? { reason: response.reason }
                        : {}),
                    },
                  } as UIMessage["parts"][number])
                : part,
            ),
          }
        : message,
    );
    this.setThreadMessages(threadId, messages);
    await this.persist(threadId);
    await this.startRun(threadId, messages, {
      resumeAssistantId: target.messageId,
    });
  }

  async compact(threadId: string, instructions?: string): Promise<void> {
    // A run streaming into this thread owns its message array; writing a
    // boundary underneath it would clobber the streaming message, and the run's
    // next write would then drop the boundary.
    if (this.controllers.has(threadId)) {
      throw new ChatError(
        "A run is in flight; wait for it to finish before compacting.",
      );
    }
    const thread = await this.requireThread(threadId);
    const beforeIds = new Set(thread.messages.map((message) => message.id));
    // Registered like a run so `cancel` and `dispose` can abort a summarization
    // in flight, and so a vault lock does not leave one running against a
    // cleared store.
    const controller = new AbortController();
    this.controllers.set(threadId, controller);
    useChatStore.getState().beginCompaction(threadId);
    try {
      const compacted = await compactThread(
        this.deps,
        thread,
        instructions,
        controller.signal,
      );
      // Only the messages move: a whole-object write would also restore the
      // `plan`, `mode` and `config` captured before the await.
      const live = useChatStore.getState().threads[threadId];
      const compactedIds = new Set(compacted.messages.map((message) => message.id));
      // A notice can settle onto the thread while the summary call is running;
      // carry those appended messages over so compaction does not drop them.
      const added = live
        ? live.messages.filter(
            (message) =>
              !beforeIds.has(message.id) && !compactedIds.has(message.id),
          )
        : [];
      this.setThreadMessages(threadId, [...compacted.messages, ...added]);
      await this.persist(threadId);
    } finally {
      useChatStore.getState().endCompaction(threadId);
      if (this.controllers.get(threadId) === controller)
        this.controllers.delete(threadId);
    }
  }

  async cancel(threadId: string): Promise<void> {
    const controller = this.controllers.get(threadId);
    if (!controller) return;
    controller.abort();
    await this.runs.get(threadId);
  }

  appendAgentNotice(
    threadId: string,
    text: string,
    runId?: string,
    report?: AgentNoticeReport,
  ): void {
    void this.writeNotice(threadId, text, runId, report);
  }

  private async writeNotice(
    threadId: string,
    text: string,
    runId?: string,
    report?: AgentNoticeReport,
  ): Promise<void> {
    const thread = useChatStore.getState().threads[threadId];
    if (!thread) return;
    const data: { text: string } & AgentNoticeMeta = {
      text,
      ...(runId !== undefined ? { runId } : {}),
      ...report,
      status: report?.status ?? "completed",
      response: report?.response ?? text,
    };
    const part: AgentNoticePart = { type: "data-agent-notice", data };

    const streaming = thread.messages.find(
      (message) =>
        message.role === "assistant" &&
        (message.metadata as { chatStatus?: unknown } | undefined)?.chatStatus ===
          "streaming",
    );
    if (streaming) {
      const key = noticeKeyOf(part);
      if (
        key !== undefined &&
        streaming.parts.some((existing) => noticeKeyOf(existing) === key)
      ) {
        return;
      }
      await this.saveNotice(threadId, {
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === streaming.id
            ? { ...message, parts: [...message.parts, part] }
            : message,
        ),
        updatedAt: Date.now(),
      });
      return;
    }

    const message: UIMessage = {
      id: createMessageId(),
      role: "assistant",
      parts: [{ type: "text", text }, part],
      metadata: {
        chatStatus: "done",
        agentNotice: true,
        untrusted: true,
        ...(runId !== undefined ? { runId } : {}),
        ...(report !== undefined
          ? { agentReport: { ...report, ...(runId !== undefined ? { runId } : {}) } }
          : {}),
      },
    };
    await this.saveNotice(threadId, {
      ...thread,
      messages: [...thread.messages, message],
      updatedAt: Date.now(),
    });
  }

  private async saveNotice(threadId: string, next: ChatThread): Promise<void> {
    useChatStore.getState().setThread(next);
    try {
      await this.deps.threadStore.saveThread(next);
    } catch (error) {
      // Notices are fire-and-forget; a failed write must never surface as an
      // unhandled rejection. A lock drops the thread the same way a run's own
      // persist does.
      if (error instanceof VaultLockedError)
        useChatStore.getState().removeThread(threadId);
    }
  }

  private async requireThread(id: string): Promise<ChatThread> {
    const existing = useChatStore.getState().threads[id];
    if (existing) return existing;
    const loaded = await this.deps.threadStore.loadThread(id);
    if (!loaded) throw new ChatThreadNotFoundError(id);
    const rehydrated = rehydrateThread(loaded);
    useChatStore.getState().setThread(rehydrated);
    return rehydrated;
  }

  private setThreadMessages(threadId: string, messages: UIMessage[]): void {
    const current = useChatStore.getState().threads[threadId];
    if (!current) return;
    useChatStore.getState().setThread({ ...current, messages });
  }

  /**
   * Replaces the run's assistant message in place, by id, reading the current
   * store synchronously. A notice injected mid-run therefore survives every
   * chunk and the final write, and no sibling message is disturbed.
   */
  private updateAssistantMessage(
    threadId: string,
    messageId: string,
    update: (current: UIMessage | undefined) => UIMessage,
  ): void {
    const thread = useChatStore.getState().threads[threadId];
    if (!thread) return;
    let replaced = false;
    const messages = thread.messages.map((message) => {
      if (message.id !== messageId) return message;
      replaced = true;
      return update(message);
    });
    if (!replaced) messages.push(update(undefined));
    useChatStore.getState().setThread({
      ...thread,
      messages,
      updatedAt: Date.now(),
    });
  }

  /**
   * Marks the run's assistant message as failed in place. Returns false when the
   * message is gone (a pre-stream failure dropped the placeholder), so the
   * caller can fall back to the global error banner.
   */
  private flagRunFailure(
    threadId: string,
    messageId: string,
    error: string,
  ): boolean {
    const current = useChatStore.getState().threads[threadId];
    if (!current) return false;
    let found = false;
    const messages = current.messages.map((message) => {
      if (message.id !== messageId) return message;
      found = true;
      const metadata = (message.metadata as Record<string, unknown> | undefined) ?? {};
      return {
        ...message,
        metadata: { ...metadata, chatStatus: "done", error },
      };
    });
    if (!found) return false;
    useChatStore.getState().setThread({
      ...current,
      messages,
      updatedAt: Date.now(),
    });
    return true;
  }

  private async persist(threadId: string): Promise<void> {
    const thread = useChatStore.getState().threads[threadId];
    if (!thread) return;
    const next: ChatThread = { ...thread, updatedAt: Date.now() };
    useChatStore.getState().setThread(next);
    try {
      await this.deps.threadStore.saveThread(next);
    } catch (error) {
      if (error instanceof VaultLockedError) {
        // The lock subscription in store.ts clears the chat state; do not touch
        // the global status here or a concurrent thread's run loses its flag.
        useChatStore.getState().removeThread(threadId);
        return;
      }
      throw error;
    }
  }

  /**
   * Compacts before the run when the context has reached the configured share
   * of the cap. Never called for an approval resume: a resume continues a
   * paused tool call inside an existing assistant message, and re-slicing the
   * history under it would strand that call.
   *
   * A failure here is reported but not fatal. The alternative — dropping the
   * user's turn because a summary call failed — loses work, so the run
   * continues on the uncompacted base and may simply hit the provider's own
   * limit instead.
   */
  private async autoCompact(
    threadId: string,
    thread: ChatThread,
    base: UIMessage[],
    signal: AbortSignal,
  ): Promise<UIMessage[]> {
    const cap = resolveContextCap(this.deps.getSettings(), thread.config);
    if (!shouldAutoCompact(contextTokensOf(base).tokens, cap)) return base;

    const { history, tail } = splitTrailingUserTurn(base);
    if (history.length === 0) return base;

    useChatStore.getState().beginCompaction(threadId);
    try {
      const compacted = await compactThread(
        this.deps,
        { ...thread, messages: history },
        undefined,
        signal,
      );
      const next = [...compacted.messages, ...tail];
      this.setThreadMessages(threadId, next);
      await this.persist(threadId);
      return next;
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return base;
      useChatStore.getState().setError(redactSecrets(messageOf(error)));
      return base;
    } finally {
      useChatStore.getState().endCompaction(threadId);
    }
  }

  private async startRun(
    threadId: string,
    baseMessages: UIMessage[],
    options: { resumeAssistantId?: string } = {},
  ): Promise<void> {
    const previous = this.runs.get(threadId);
    this.controllers.get(threadId)?.abort();
    if (previous) await previous.catch(() => undefined);

    const thread = await this.requireThread(threadId);
    const controller = new AbortController();
    this.controllers.set(threadId, controller);
    useChatStore.getState().beginRun(threadId);
    useChatStore.getState().setError(null);

    const resume = options.resumeAssistantId !== undefined;
    const assistantId = options.resumeAssistantId ?? createMessageId();
    // A non-resume run expires any stale paused approval before it starts; a
    // resume keeps the responded part it was given.
    const expired = resume ? baseMessages : baseMessages.map(expireApprovals);

    // Everything after this point lives inside the run promise, which is
    // registered before any await. Auto-compaction is a model round-trip, and
    // registering afterwards would leave `this.runs` holding the *previous*
    // run for seconds: a concurrent `startRun` would abort this controller but
    // await the wrong promise, and both runs would proceed.
    const run = (async () => {
      try {
        const runBase = resume
          ? expired
          : await this.autoCompact(threadId, thread, expired, controller.signal);
        if (resume) {
          this.setThreadMessages(threadId, runBase);
        } else {
          // Carry over any message that landed while the pre-run compaction was
          // in flight (a notice) so appending the placeholder does not drop it.
          const live = useChatStore.getState().threads[threadId];
          const known = new Set(runBase.map((message) => message.id));
          const extra = live
            ? live.messages.filter(
                (message) => !known.has(message.id) && message.id !== assistantId,
              )
            : [];
          this.setThreadMessages(threadId, [
            ...runBase,
            ...extra,
            {
              id: assistantId,
              role: "assistant",
              parts: [],
              metadata: { chatStatus: "streaming" },
            } satisfies UIMessage,
          ]);
        }
        await this.executeRun(
          thread,
          runBase,
          assistantId,
          controller,
          thread.mode ?? "editing",
        );
      } catch (error) {
        if (!controller.signal.aborted && !isAbortError(error)) {
          const message = redactSecrets(messageOf(error));
          // A failed run is surfaced on its own assistant message so the error
          // renders in the conversation next to a Retry action. Only when the
          // placeholder no longer exists (a pre-stream build failure) does it
          // fall back to the global banner.
          if (this.flagRunFailure(threadId, assistantId, message)) {
            await this.persist(threadId).catch(() => undefined);
          } else {
            useChatStore.getState().setError(message);
          }
        }
      } finally {
        if (this.controllers.get(threadId) === controller)
          this.controllers.delete(threadId);
        useChatStore.getState().endRun(threadId);
      }
    })();

    this.runs.set(threadId, run);
    await run;
  }

  private async executeRun(
    thread: ChatThread,
    baseMessages: UIMessage[],
    assistantId: string,
    controller: AbortController,
    mode: ChatMode,
  ): Promise<void> {
    const modePort: ThreadModePort = {
      setMode: async (next) => {
        const current = useChatStore.getState().threads[thread.id];
        if (!current) return;
        const updated = patchThreadMode(current, next);
        useChatStore.getState().setThread(updated);
        await this.deps.threadStore.saveThread(updated);
      },
    };
    const planPort: ThreadPlanPort = {
      get: () => useChatStore.getState().threads[thread.id]?.plan ?? [],
      set: async (items) => {
        const current = useChatStore.getState().threads[thread.id];
        if (!current) return;
        const next: ChatThread = { ...current, plan: [...items], updatedAt: Date.now() };
        useChatStore.getState().setThread(next);
        try {
          await this.deps.threadStore.saveThread(next);
        } catch (error) {
          if (error instanceof VaultLockedError) {
            useChatStore.getState().removeThread(thread.id);
          }
          throw error;
        }
      },
    };
    const agentContext: AgentParentContext = {
      parentThreadId: thread.id,
      mode,
      providerId: thread.config.providerId,
      ...(thread.config.modelId !== undefined
        ? { modelId: thread.config.modelId }
        : {}),
      systemInstruction: thread.config.systemInstruction,
      toolNames: [],
    };
    const built = await (async () => {
      try {
        const journal = this.deps.journalFor
          ? await this.deps.journalFor(thread.id)
          : undefined;
        return await buildRunStream(
          this.deps,
          thread.config,
          baseMessages,
          controller.signal,
          () => assistantId,
          mode,
          modePort,
          planPort,
          journal,
          agentContext,
        );
      } catch (error) {
        // A pre-stream failure (bad provider config, conversion error) must not
        // leave the streaming placeholder behind, or it re-enters later turns.
        // Any notice that landed meanwhile stays.
        const live = useChatStore.getState().threads[thread.id];
        const known = new Set(baseMessages.map((message) => message.id));
        const extra = live
          ? live.messages.filter(
              (message) => !known.has(message.id) && message.id !== assistantId,
            )
          : [];
        this.setThreadMessages(thread.id, [...baseMessages, ...extra]);
        await this.persist(thread.id);
        throw error;
      }
    })();

    const existing = baseMessages.find((message) => message.id === assistantId);
    let latest: UIMessage = existing ?? {
      id: assistantId,
      role: "assistant",
      parts: [],
      metadata: { chatStatus: "streaming" },
    };
    let failure: unknown;

    // A resumed run continues a message that already holds text, so the rate is
    // measured from what this run adds rather than from the whole message.
    const charsBefore = existing ? outputCharsOf(existing) : 0;
    useChatStore.getState().setLiveStats(thread.id, {
      startedAt: Date.now(),
      chars: 0,
    });

    try {
      for await (const partial of readUIMessageStream({
        stream: built.stream,
        // A resumed run continues the existing assistant message, so the
        // reconstructor needs it as its base to resolve the tool output.
        ...(existing ? { message: existing } : {}),
        // Without this the SDK swallows provider errors (it only invokes
        // `onError`), so the run would end silently with no inline error.
        terminateOnError: true,
      })) {
        latest = partial;
        this.updateAssistantMessage(thread.id, assistantId, (current) =>
          mergeNoticeParts(setChatStatus(partial, "streaming"), current),
        );
        const stats = useChatStore.getState().liveStats[thread.id];
        if (stats)
          useChatStore
            .getState()
            .setLiveStats(thread.id, {
              ...stats,
              chars: Math.max(0, outputCharsOf(partial) - charsBefore),
            });
      }
    } catch (error) {
      failure = error;
    }

    useChatStore.getState().clearLiveStats(thread.id);

    const finished = sanitizePartial(latest);
    this.updateAssistantMessage(thread.id, assistantId, (current) =>
      mergeNoticeParts(finished, current),
    );
    await this.persist(thread.id);

    if (failure && !controller.signal.aborted && !isAbortError(failure))
      throw failure;

    // A successful turn names the conversation on its first user message and
    // re-names it every fifth one afterwards. A title the user set manually is
    // never touched. Fire-and-forget: naming must not delay the run from
    // settling, and its failure must not reach the chat as an error.
    void this.maybeNameConversation(thread.id, controller.signal);
  }

  private async maybeNameConversation(
    threadId: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const current = useChatStore.getState().threads[threadId];
      if (!current || !shouldGenerateTitle(current)) return;
      const userCount = countUserMessages(current);
      const settings = this.deps.getSettings();
      if (!settings) return;
      const title = await generateConversationTitle({
        settings,
        thread: current,
        ...(this.deps.modelFactory ? { factory: this.deps.modelFactory } : {}),
        signal,
      });
      if (!title) return;
      // Re-check before writing: the user may have renamed during the round trip.
      const latest = useChatStore.getState().threads[threadId];
      if (!latest || !shouldGenerateTitle(latest)) return;
      const named: ChatThread = {
        ...latest,
        title: normalizeTitle(title),
        titleSource: "auto",
        titleUserCount: userCount,
        updatedAt: Date.now(),
      };
      // Persist first: the conversations list re-reads storage when the store
      // changes, so updating the store before the write would race the refresh
      // and briefly (or lastingly, if nothing else changes) show the old title.
      await this.deps.threadStore.saveThread(named);
      useChatStore.getState().setThread(named);
    } catch {
      // Best-effort: a vault lock, abort, or provider error is not a chat error.
    }
  }
}

export function createEngine(deps: EngineDeps): ChatEngine {
  return new DefaultEngine(deps);
}
