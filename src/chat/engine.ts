import type { LanguageModel, UIMessage, UIMessageChunk } from "ai";
import {
  convertToModelMessages,
  readUIMessageStream,
  streamText,
  toUIMessageStream,
} from "ai";
import { createLLM } from "../ai/llm";
import type { CodeRunner } from "../sandbox/types";
import type { SkillRegistry } from "../skills/registry";
import { createAdminPorts } from "../tools/admin-ports";
import type { ToolRegistry } from "../tools/registry";
import type { ToolGateDescriptor } from "../tools/approval";
import type {
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
import { clampIndexText, composeSystemPrompt } from "./context";
import type { ResolvedSkill } from "./context";
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
import { patchThreadMode } from "./threads";
import type { ChatMode, ChatThread, ThreadConfig } from "./types";

export interface PipelineDeps {
  getSettings(): Settings | null;
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
  workspace?: WorkspaceApi;
  codeRunner?: CodeRunner;
  sandbox?: SandboxControlPort;
  preview?: PreviewPort;
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

export interface ChatEngine {
  sendTurn(threadId: string, text: string): Promise<void>;
  editMessage(
    threadId: string,
    messageId: string,
    parts: UIMessage["parts"],
  ): Promise<void>;
  rerun(threadId: string, messageId: string): Promise<void>;
  undo(threadId: string): Promise<void>;
  respondToApproval(threadId: string, response: ApprovalResponse): Promise<void>;
  cancel(threadId: string): Promise<void>;
  /** Unregisters the global abort callback and aborts any in-flight runs. */
  dispose(): void;
}

export interface BuiltRun {
  stream: ReadableStream<UIMessageChunk>;
  toolNames: string[];
}

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /(api[_-]?key["'\s:=]+)[A-Za-z0-9._-]+/gi,
];

export function redactSecrets(text: string): string {
  let output = text;
  for (const pattern of SECRET_PATTERNS)
    output = output.replace(pattern, "[redacted]");
  return output;
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
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

function collectPendingApprovals(messages: UIMessage[]): PendingApproval[] {
  const pending: PendingApproval[] = [];
  messages.forEach((message, messageIndex) => {
    if (message.role !== "assistant") return;
    message.parts.forEach((part, partIndex) => {
      const record = part as unknown as Record<string, unknown>;
      if (record.state !== "approval-requested") return;
      const approval = record.approval as { id?: unknown } | undefined;
      if (!approval || typeof approval.id !== "string") return;
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
): Promise<BuiltRun> {
  const settings = deps.getSettings();
  if (!settings)
    throw new ChatError("The vault is locked; the chat cannot run.");

  const skills = deps.skillRegistry.resolve(config.enabledSkills);
  const ports = {
    workspace: deps.workspace,
    codeRunner: deps.codeRunner,
    sandbox: deps.sandbox,
    preview: deps.preview,
    mode: modePort,
    skills: createSkillLoadPort(skills),
    plan: planPort,
    ...createAdminPorts({
      skillRegistry: deps.skillRegistry,
      toolRegistry: deps.toolRegistry,
    }),
  };
  const pool = new Set(deps.toolRegistry.availableNames(ports));
  const narrowed = deps.skillRegistry.toolNamesFor(
    config.enabledSkills,
    pool,
  );
  // `load_skill` is unioned in whenever a skill is enabled, because a skill's
  // `allowedTools` narrowing would otherwise exclude the tool the index needs.
  const requestedTools =
    narrowed === undefined
      ? undefined
      : skills.length > 0 && pool.has("load_skill") && !narrowed.includes("load_skill")
        ? [...narrowed, "load_skill"]
        : narrowed;
  const toolSet = deps.toolRegistry.buildToolSet(requestedTools, ports);
  const system = composeSystemPrompt(
    config.systemInstruction,
    skills,
    Object.keys(toolSet),
  );

  const gateTools: ToolGateDescriptor[] = Object.keys(toolSet).map((name) => {
    const kind = deps.toolRegistry.userToolKind(name);
    return kind ? { name, kind } : { name };
  });
  const toolApproval = createToolApproval(mode, settings.approvals, gateTools);

  const modelFactory = deps.modelFactory ?? createLLM;
  const model = modelFactory(settings, config.providerId, config.modelId);
  const modelMessages = await convertToModelMessages(messages, {
    tools: toolSet,
    ignoreIncompleteToolCalls: true,
  });

  const result = streamText({
    model,
    system,
    messages: modelMessages,
    tools: toolSet,
    toolApproval,
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

  const stream = toUIMessageStream({
    stream: result.stream,
    tools: toolSet,
    originalMessages: messages,
    generateMessageId,
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

  async sendTurn(threadId: string, text: string): Promise<void> {
    const thread = await this.requireThread(threadId);
    const userMessage: UIMessage = {
      id: createMessageId(),
      role: "user",
      parts: [{ type: "text", text }],
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

  async cancel(threadId: string): Promise<void> {
    const controller = this.controllers.get(threadId);
    if (!controller) return;
    controller.abort();
    await this.runs.get(threadId);
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
    const runBase = resume ? baseMessages : baseMessages.map(expireApprovals);
    if (resume) {
      this.setThreadMessages(threadId, runBase);
    } else {
      this.setThreadMessages(threadId, [
        ...runBase,
        {
          id: assistantId,
          role: "assistant",
          parts: [],
          metadata: { chatStatus: "streaming" },
        } satisfies UIMessage,
      ]);
    }

    const run = (async () => {
      try {
        await this.executeRun(
          thread,
          runBase,
          assistantId,
          controller,
          thread.mode ?? "editing",
        );
      } catch (error) {
        if (!controller.signal.aborted && !isAbortError(error)) {
          useChatStore.getState().setError(redactSecrets(describe(error)));
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
    const built = await (async () => {
      try {
        return await buildRunStream(
          this.deps,
          thread.config,
          baseMessages,
          controller.signal,
          () => assistantId,
          mode,
          modePort,
          planPort,
        );
      } catch (error) {
        // A pre-stream failure (bad provider config, conversion error) must not
        // leave the streaming placeholder behind, or it re-enters later turns.
        this.setThreadMessages(thread.id, baseMessages);
        await this.persist(thread.id);
        throw error;
      }
    })();

    const siblings = baseMessages.filter((message) => message.id !== assistantId);
    const existing = baseMessages.find((message) => message.id === assistantId);
    let latest: UIMessage = existing ?? {
      id: assistantId,
      role: "assistant",
      parts: [],
      metadata: { chatStatus: "streaming" },
    };
    let failure: unknown;

    try {
      for await (const partial of readUIMessageStream({
        stream: built.stream,
        // A resumed run continues the existing assistant message, so the
        // reconstructor needs it as its base to resolve the tool output.
        ...(existing ? { message: existing } : {}),
      })) {
        latest = partial;
        this.setThreadMessages(thread.id, [...siblings, setChatStatus(partial, "streaming")]);
      }
    } catch (error) {
      failure = error;
    }

    const finished = sanitizePartial(latest);
    this.setThreadMessages(thread.id, [...siblings, finished]);
    await this.persist(thread.id);

    if (failure && !controller.signal.aborted && !isAbortError(failure))
      throw failure;
  }
}

export function createEngine(deps: EngineDeps): ChatEngine {
  return new DefaultEngine(deps);
}
