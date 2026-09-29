import type { UIMessage } from 'ai'
import type { ChatEngine, EngineDeps, ThreadStore } from '../chat/engine'
import { createEngine, createSkillLoadPort } from '../chat/engine'
import type { AgentParentContext, AgentSpawnOutcome } from '../agents/types'
import { summarizeAgentResult } from '../agents/types'
import { createWorkspaceProfileSource } from '../agents/profile-workspace-source'
import { AgentProfileRegistry } from '../agents/profiles'
import { createAgentRuntime } from '../agents/runtime'
import type { AgentRunPersistence, AgentRunSnapshot, AgentRuntime } from '../agents/runtime'
import { agentRunStore } from '../agents/store'
import type { AgentRunRecord } from '../agents/store'
import type { AgentNoticeReport, ChatThread, ThreadConfig } from '../chat/types'
import { defaultThreadConfig } from '../chat/types'
import {
  deleteThread,
  listAgentRuns,
  listThreads,
  loadThread,
  saveThread,
} from '../chat/persistence'
import { rehydrateThread } from '../chat/sanitize'
import { useChatStore } from '../chat/store'
import { labelConversation } from '../chat/threads'
import { createEmbedder } from '../ai/embedder'
import { createTierModel } from '../ai/model-tier'
import { createTypeSafe } from '../ai/typesafe'
import { createRagPort, resolveEmbedProviderId } from '../rag/port'
import type { RagPort } from '../rag/port'
import { createJevCache, SYSTEM_ONE_TIMEOUT_MS } from '../rag/jev'
import { createSandboxManager } from '../sandbox/manager'
import type { SandboxManager } from '../sandbox/manager'
import { createVaultSkillEnablement } from '../skills/enablement'
import type { SkillEnablementPort } from '../skills/enablement'
import { SkillRegistry } from '../skills/registry'
import { createAdminPorts } from '../tools/admin-ports'
import { createAgentsToolProvider } from '../tools/builtin/agents'
import { createCheckToolProvider } from '../tools/builtin/check'
import { createCodeToolProvider } from '../tools/builtin/code'
import type { CodeRunnerSource } from '../tools/builtin/code'
import { createHistoryToolProvider } from '../tools/builtin/history'
import { createModeToolProvider } from '../tools/builtin/mode'
import { createPlanToolProvider } from '../tools/builtin/plan'
import { createPreviewToolProvider } from '../tools/builtin/preview'
import { createRagToolProvider } from '../tools/builtin/rag'
import { createMemoryToolProvider } from '../tools/builtin/memory'
import { createSandboxControlProvider } from '../tools/builtin/sandbox-control'
import { createSkillManagementProvider } from '../tools/builtin/skill-management'
import { createSkillToolProvider } from '../tools/builtin/skills'
import { createToolGuideProvider } from '../tools/builtin/tool-guide'
import { createToolManagementProvider } from '../tools/builtin/tool-management'
import type { AgentSpawnPort, JsonSchemaObject, McpResourcePort, MemoryPort, PreviewPort, SandboxControlPort, ToolProvider, ToolRuntimePorts } from '../tools/types'
import { workspaceToolProvider } from '../tools/builtin/workspace'
import { ToolRegistry } from '../tools/registry'
import { useVaultStore } from '../vault/store'
import {
  DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
  DEFAULT_SANDBOX_JS_TIMEOUT_MS,
  DEFAULT_SANDBOX_PY_TIMEOUT_MS,
} from '../vault/settings'
import type { SandboxSettings, Settings } from '../vault/settings'
import type { WorkspaceFs } from '../workspace/fs'
import { workspaceJournal } from '../workspace/journal'
import { workspaceJournalStore } from '../workspace/journal-store'
import type { RunFileChange } from '../workspace/journal'
import { applyRunRevert, tagJournal } from '../workspace/run-journal'
import type { RunRevertOutcome } from '../workspace/run-journal'
import { bindMemoryPort, createMemoryPort } from '../memory/port'
import { useMemoryStore } from '../memory/state'
import { McpConnectionManager } from '../mcp/manager'
import { bindMcpTools, mcpToolPrefix } from '../mcp/tool-bridge'
import { createMcpResourcePort } from '../mcp/resource-port'
import { createMcpResourceToolProvider } from '../tools/builtin/mcp-resources'
import { createTerminalToolProvider } from '../tools/builtin/terminal'
import { TerminalManager } from '../terminal/manager'
import { restoreWorkspace, restoreWorkspaceHandle, threadHandleId } from '../workspace/handle'
import { useFileViewStore } from './file-view-state'
import { useWorkspaceStore } from './workspace-state'

export interface BuiltinProviderInfo {
  name: string
  available: boolean
  description: string
  inputSchema?: JsonSchemaObject
}

function readJsonSchema(schema: unknown): JsonSchemaObject | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined
  const candidate = (schema as { jsonSchema?: unknown }).jsonSchema
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return undefined
  return candidate as JsonSchemaObject
}

function describeBuiltinTool(
  provider: ToolProvider,
  name: string,
  ports: ToolRuntimePorts,
): Pick<BuiltinProviderInfo, 'description' | 'inputSchema'> {
  try {
    const built = provider.create(name, ports)
    const inputSchema = readJsonSchema(built.inputSchema)
    return {
      description: typeof built.description === 'string' ? built.description : '',
      ...(inputSchema ? { inputSchema } : {}),
    }
  } catch {
    // Unavailable tools (e.g. no workspace) refuse to build; their list entry
    // still surfaces availability, just without details.
    return { description: '' }
  }
}

/**
 * The app's single composition root: one skill registry, one tool registry, one
 * thread-store shim, one runner source, and a per-thread engine map. Created per
 * vault unlock by `SessionProvider` and disposed on lock.
 */
export interface AppSession {
  skillRegistry: SkillRegistry
  toolRegistry: ToolRegistry
  agentProfiles: AgentProfileRegistry
  threadStore: ThreadStore
  runnerSource: CodeRunnerSource
  engineFor(threadId: string): ChatEngine
  disposeThread(threadId: string, options?: { deleted?: boolean }): void
  dispose(): void
  /** Aborts one delegated run by id. */
  cancelAgentRun(runId: string): void
  /** Steers a live delegated run; false when the run is not live. */
  steerAgentRun(runId: string, text: string): boolean
  /** Force-stops a live delegated run; false when the run is not live. */
  stopAgentRun(runId: string): boolean
  continueAgentRun(runId: string, text: string): Promise<AgentSpawnOutcome>
  agentRunChanges(runId: string): Promise<{ changes: RunFileChange[]; expired: boolean }>
  revertAgentRun(runId: string): Promise<RunRevertOutcome | { error: string }>
  getWorkspace(): WorkspaceFs | null
  setWorkspace(fs: WorkspaceFs | null): void
  /** Builtin tools with availability and introspection details for the given thread config's ports. */
  builtinProviders(config?: ThreadConfig): BuiltinProviderInfo[]
  sandbox(): SandboxManager | null
  mcp: McpConnectionManager
  mcpResources: McpResourcePort
  startMcp(): Promise<void>
  terminal: TerminalManager
  startTerminal(): void
}

export interface SessionOptions {
  skillRegistry?: SkillRegistry
  skillEnablement?: SkillEnablementPort
  toolRegistry?: ToolRegistry
  threadStore?: ThreadStore
  runnerSource?: CodeRunnerSource
  sandboxManager?: SandboxManager
  getSettings?: () => Settings | null
  mcpManager?: McpConnectionManager
  terminalManager?: TerminalManager
}

function currentSandbox(): SandboxSettings {
  return (
    useVaultStore.getState().settings?.sandbox ?? {
      enabled: true,
      jsTimeoutMs: DEFAULT_SANDBOX_JS_TIMEOUT_MS,
      pyTimeoutMs: DEFAULT_SANDBOX_PY_TIMEOUT_MS,
      idleTimeoutMs: DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
    }
  )
}

/** Builds the durable child agent thread for one delegated run. */
function agentThreadFrom(snapshot: AgentRunSnapshot): ChatThread {
  return {
    id: snapshot.runId,
    title: snapshot.label?.trim() || 'Agent run',
    messages: snapshot.messages,
    config: defaultThreadConfig(snapshot.providerId, snapshot.modelId),
    mode: snapshot.mode,
    createdAt: snapshot.startedAt,
    updatedAt: Date.now(),
    agent: {
      runId: snapshot.runId,
      parentThreadId: snapshot.parentThreadId,
      ...(snapshot.label !== undefined ? { label: snapshot.label } : {}),
      ...(snapshot.profile !== undefined ? { profile: snapshot.profile } : {}),
      mode: snapshot.mode,
      tier: snapshot.tier,
      status: snapshot.status,
      ...(snapshot.stopReason !== undefined ? { stopReason: snapshot.stopReason } : {}),
      ...(snapshot.spec !== undefined ? { spec: snapshot.spec } : {}),
    },
  }
}

/** Reads a child thread's first user message as the run prompt. */
function promptFromMessages(messages: UIMessage[]): string {
  const first = messages.find((message) => message.role === 'user')
  if (!first) return ''
  return first.parts
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
}

/** Rebuilds a run snapshot from a persisted child thread; null is not a child. */
function agentSnapshotFrom(thread: ChatThread): AgentRunSnapshot | null {
  const meta = thread.agent
  if (!meta) return null
  return {
    runId: meta.runId,
    parentThreadId: meta.parentThreadId,
    providerId: thread.config.providerId,
    ...(thread.config.modelId !== undefined ? { modelId: thread.config.modelId } : {}),
    mode: meta.mode,
    tier: meta.tier,
    ...(meta.label !== undefined ? { label: meta.label } : {}),
    ...(meta.profile !== undefined ? { profile: meta.profile } : {}),
    status: meta.status,
    ...(meta.stopReason !== undefined ? { stopReason: meta.stopReason } : {}),
    prompt: promptFromMessages(thread.messages),
    messages: thread.messages,
    startedAt: thread.createdAt,
    ...(meta.spec !== undefined ? { spec: meta.spec } : {}),
  }
}

/**
 * Words a settled run's parent notice. A user stop is named as such rather than
 * surfacing as a generic finish, and the stop reason travels in the report.
 */
export function agentNoticeFor(run: AgentRunRecord): { text: string; report: AgentNoticeReport } {
  const status = run.result?.status ?? run.status
  const label = run.label ? ` "${run.label}"` : ''
  const stopReason = run.result?.stopReason ?? run.stopReason
  if (status === 'stopped') {
    return {
      text: `Sub-agent${label} stopped by the user.`,
      report: {
        status,
        response: `The user stopped the sub-agent${label}.`,
        ...(run.label !== undefined ? { label: run.label } : {}),
        ...(stopReason !== undefined ? { stopReason } : {}),
      },
    }
  }
  const response = run.result ? summarizeAgentResult(run.result) : `The agent ${run.status}.`
  const result = run.result
  const hasStructured = result !== undefined && 'structured' in result
  const filesText =
    result?.filesChanged !== undefined
      ? `\n\nFiles changed${result.filesChangedIncomplete ? ' (older changes are no longer recorded, so this list may be incomplete)' : ''}: ${result.filesChanged.join(', ')}`
      : result?.filesChangedIncomplete
        ? '\n\nFiles changed: unknown, because this run\'s changes are no longer recorded.'
        : ''
  const structuredText = hasStructured
    ? `\n\nStructured result:\n\`\`\`json\n${JSON.stringify(result.structured, null, 2)}\n\`\`\``
    : result?.structuredError !== undefined
      ? `\n\nThe structured result could not be extracted: ${result.structuredError}`
      : ''
  return {
    text: `Sub-agent${label} finished: ${response}${filesText}${structuredText}`,
    report: {
      status,
      response,
      ...(run.label !== undefined ? { label: run.label } : {}),
      ...(hasStructured ? { structured: result.structured } : {}),
      ...(result?.structuredError !== undefined ? { structuredError: result.structuredError } : {}),
      ...(result?.filesChanged !== undefined ? { filesChanged: result.filesChanged } : {}),
      ...(result?.filesChangedIncomplete ? { filesChangedIncomplete: true } : {}),
    },
  }
}

/** Binds the runtime's control surface to one calling parent's context. */
export function createAgentPorts(
  runtime: AgentRuntime,
  context: AgentParentContext,
): AgentSpawnPort {
  return {
    spawn: (request, options) => runtime.spawn(context, request, options),
    continue: (runId, text, options) => runtime.continue(context, runId, text, options),
    wait: (options, signal) => runtime.wait(context.parentThreadId, options, signal),
    steer: (runId, text) => runtime.steer(context.parentThreadId, runId, text),
    stop: (runId, reason) => runtime.stop(context.parentThreadId, runId, reason),
    read: (runId, options) => runtime.read(context.parentThreadId, runId, options),
    resolveRun: (identifier) => runtime.resolveRun(context.parentThreadId, identifier),
    profiles: () =>
      runtime.profiles().map((profile) => ({
        id: profile.id,
        description: profile.description,
        source: profile.source,
      })),
  }
}

export function createSession(options: SessionOptions = {}): AppSession {
  const threadStore: ThreadStore = options.threadStore ?? {
    loadThread,
    saveThread,
    listThreads,
    deleteThread,
  }
  const getWorkspace = (): WorkspaceFs | null => useWorkspaceStore.getState().fs
  const getSettings = options.getSettings ?? (() => useVaultStore.getState().settings)
  // The tool layer reaches the File panel only through this port, so it never
  // imports a UI store directly. `presentWorkspace` marks model authorship.
  const previewPort = (): PreviewPort => ({
    open: (path) => useFileViewStore.getState().presentWorkspace(path),
  })

  let manager: SandboxManager | null = null
  let unsubVault: (() => void) | null = null
  let unsubWorkspace: (() => void) | null = null
  let unsubFolder: (() => void) | null = null
  let unsubThread: (() => void) | null = null

  /**
   * Keeps the conversation's list label on the folder it actually runs against,
   * including the first time an older conversation adopts one.
   */
  function syncWorkspaceLabel(folderName: string | null): void {
    const { activeThreadId, threads } = useChatStore.getState()
    if (!activeThreadId) return
    const thread = threads[activeThreadId]
    if (!thread) return
    const next = folderName ?? undefined
    if (thread.workspaceName === next) return
    useChatStore.getState().setThread({ ...thread, workspaceName: next, updatedAt: Date.now() })
    void labelConversation(activeThreadId, next)
  }

  // The journal records mutations against one folder, so a folder change makes
  // it stale no matter which path changed it.
  const agentProfiles = new AgentProfileRegistry()
  const loadAgentProfiles = (fs: WorkspaceFs | null): Promise<void> =>
    agentProfiles.load(fs ? createWorkspaceProfileSource(fs) : null)
  void loadAgentProfiles(getWorkspace())

  unsubFolder = useWorkspaceStore.subscribe((state, previous) => {
    if (state.fs === previous.fs) return
    workspaceJournal.clear()
    syncWorkspaceLabel(state.folderName)
    void loadAgentProfiles(state.fs)
  })

  // One owner for "the open conversation decides the folder"; every path that
  // switches conversations goes through the chat store.
  unsubThread = useChatStore.subscribe((state, previous) => {
    if (state.activeThreadId === previous.activeThreadId) return
    void useWorkspaceStore.getState().bindThread(state.activeThreadId)
  })

  if (options.runnerSource) {
    manager = null
  } else {
    const createManager = () =>
      createSandboxManager({
        settings: currentSandbox(),
        // A live resolver, not a snapshot: the folder is often granted after
        // this session is created, and the sandbox bridge must see it.
        getWorkspace: () => getWorkspace() ?? undefined,
      })
    manager = options.sandboxManager ?? createManager()
    // Rebuild the workspace-bound pair when the folder changes; apply
    // settings-driven timeout changes without rebuilding on unrelated writes.
    unsubWorkspace = useWorkspaceStore.subscribe((state, previous) => {
      if (state.fs === previous.fs || !manager) return
      manager.dispose()
      manager = createManager()
    })
    unsubVault = useVaultStore.subscribe((state, previous) => {
      const next = state.settings?.sandbox
      if (next === previous.settings?.sandbox || !manager) return
      manager.setSettings(next ?? currentSandbox())
    })
  }

  const runnerSource: CodeRunnerSource =
    options.runnerSource ??
    {
      getRunners: () => manager!.toolRunners(),
      isEnabled: () => currentSandbox().enabled,
    }

  const skillRegistry =
    options.skillRegistry ??
    new SkillRegistry(undefined, options.skillEnablement ?? createVaultSkillEnablement())
  const toolRegistry = options.toolRegistry ?? new ToolRegistry()
  const mcp =
    options.mcpManager ??
    new McpConnectionManager({
      forgetToolDecisions: (serverName) => {
        const vault = useVaultStore.getState()
        const prefix = mcpToolPrefix(serverName)
        const names = Object.keys(vault.settings?.approvals?.tools ?? {}).filter((name) =>
          name.startsWith(prefix),
        )
        if (names.length === 0) return
        void vault.forgetApprovals(names).catch(() => undefined)
      },
    })
  let unbindMcpTools: (() => void) | null = null
  function startMcp(): Promise<void> {
    mcp.revive()
    unbindMcpTools?.()
    unbindMcpTools = bindMcpTools(mcp, toolRegistry)
    return mcp.hydrate()
  }
  const terminal =
    options.terminalManager ??
    new TerminalManager({
      getSettings,
      saveConfig: (config) => useVaultStore.getState().setTerminal(config),
      handleFor: async (threadId) => {
        const stored = await restoreWorkspaceHandle(threadHandleId(threadId))
        if (stored) return stored.handle
        const live = useWorkspaceStore.getState()
        if (live.boundThreadId === threadId && live.fs) return live.fs.handle
        return (await restoreWorkspace())?.handle ?? null
      },
    })
  function startTerminal(): void {
    terminal.revive()
  }
  const codeProvider = createCodeToolProvider(runnerSource)

  const sandboxControlPort = (): SandboxControlPort | undefined => {
    if (!manager) return undefined
    const active = manager
    return {
      reset: (language) => active.reset(language, 'tool'),
      status: () => {
        const availability = active.availability()
        return { js: availability.js, python: availability.python }
      },
    }
  }
  const sandboxControlProvider = createSandboxControlProvider({
    isEnabled: () => runnerSource.isEnabled(),
    getPort: sandboxControlPort,
  })

  // Lazily created per session: requires the vault to be unlocked, a provider
  // that resolves, and a TypeSafe key. The one construction site of the
  // TypeSafe client, so its judgments are discarded with the session.
  let ragPortInstance: RagPort | undefined
  function ragPort(): RagPort | undefined {
    if (ragPortInstance) return ragPortInstance
    const settings = getSettings()
    if (!settings) return undefined
    if (!settings.typesafe.apiKey.trim()) return undefined
    try {
      // Validate the embedding target before advertising the tools.
      createEmbedder(settings, resolveEmbedProviderId(settings))
      ragPortInstance = createRagPort({
        getSettings,
        embedderFor: (current) => createEmbedder(current, resolveEmbedProviderId(current)),
        typesafe: createTypeSafe(settings, { timeoutMs: SYSTEM_ONE_TIMEOUT_MS }),
        rewriteModel: (current) => createTierModel(current, 'cheap') ?? undefined,
        cache: createJevCache(),
      })
    } catch {
      return undefined
    }
    return ragPortInstance
  }
  const ragProvider = createRagToolProvider(() => ragPort())

  const modeProvider = createModeToolProvider()
  const skillProvider = createSkillToolProvider({ isEnabled: () => runnerSource.isEnabled() })
  const planProvider = createPlanToolProvider()
  const skillManagementProvider = createSkillManagementProvider()
  const toolManagementProvider = createToolManagementProvider()
  const toolGuideProvider = createToolGuideProvider()
  const previewProvider = createPreviewToolProvider()
  const checkProvider = createCheckToolProvider()
  const historyProvider = createHistoryToolProvider()
  const agentsProvider = createAgentsToolProvider()
  const memoryProvider = createMemoryToolProvider()
  const mcpResourceProvider = createMcpResourceToolProvider()
  const terminalProvider = createTerminalToolProvider()
  const mcpResourcePort = createMcpResourcePort(mcp)

  async function memoryPortFor(threadId: string | undefined): Promise<MemoryPort | undefined> {
    const store = useMemoryStore.getState()
    if (store.status !== 'ready') return undefined
    return createMemoryPort({
      store,
      handle: getWorkspace()?.handle ?? null,
      ...(threadId !== undefined ? { threadId } : {}),
    })
  }

  if (!options.toolRegistry) {
    toolRegistry.registerProvider(workspaceToolProvider)
    toolRegistry.registerProvider(checkProvider)
    toolRegistry.registerProvider(historyProvider)
    toolRegistry.registerProvider(codeProvider)
    toolRegistry.registerProvider(sandboxControlProvider)
    toolRegistry.registerProvider(modeProvider)
    toolRegistry.registerProvider(skillProvider)
    toolRegistry.registerProvider(planProvider)
    toolRegistry.registerProvider(skillManagementProvider)
    toolRegistry.registerProvider(toolManagementProvider)
    toolRegistry.registerProvider(previewProvider)
    toolRegistry.registerProvider(toolGuideProvider)
    toolRegistry.registerProvider(ragProvider)
    toolRegistry.registerProvider(agentsProvider)
    toolRegistry.registerProvider(memoryProvider)
    toolRegistry.registerProvider(mcpResourceProvider)
    toolRegistry.registerProvider(terminalProvider)
  }

  // The session-scoped agent runtime owns every detached run: caps, per-run
  // controllers, and the global abort. Its ports mirror `buildRunStream` so a
  // delegated tool does not silently disappear.
  const agentPersistence: AgentRunPersistence = {
    create: async (snapshot) => {
      await saveThread(agentThreadFrom(snapshot))
    },
    save: async (snapshot) => {
      await saveThread(agentThreadFrom(snapshot))
    },
    load: async (runId) => {
      const thread = await loadThread(runId)
      return thread ? agentSnapshotFrom(rehydrateThread(thread)) : null
    },
    list: async (parentThreadId) => {
      const threads = await listAgentRuns(parentThreadId)
      return threads
        .map((thread) => agentSnapshotFrom(thread))
        .filter((snapshot): snapshot is AgentRunSnapshot => snapshot !== null)
    },
  }
  const agentRuntime = createAgentRuntime({
    getSettings,
    skillRegistry,
    toolRegistry,
    store: agentRunStore,
    persistence: agentPersistence,
    profiles: {
      get: (id) => agentProfiles.get(id),
      list: () => agentProfiles.list(),
      refresh: () => loadAgentProfiles(getWorkspace()),
    },
    portsFor: async (context, runId) => {
      // The parent thread's journal, so a sub-agent's writes are recorded with
      // the parent's and stay undoable from the conversation.
      const journal = await workspaceJournalStore.forThread(context.parentThreadId)
      const memory = await memoryPortFor(context.parentThreadId).catch(() => undefined)
      return {
        rag: ragPort(),
        mcp: mcpResourcePort,
        workspace: getWorkspace() ?? undefined,
        codeRunner: runnerSource.getRunners().js,
        sandbox: sandboxControlPort(),
        preview: previewPort(),
        journal: runId !== undefined ? tagJournal(journal, runId) : journal,
        skills: createSkillLoadPort(skillRegistry.resolve(skillRegistry.snapshotEnabled())),
        plan: { get: () => [], set: async () => {} },
        ...(memory ? { memory } : {}),
        terminal: {
          port: terminal,
          threadId: context.parentThreadId,
          ...(runId !== undefined ? { runId } : {}),
        },
        ...createAdminPorts({ skillRegistry, toolRegistry }),
      }
    },
    onSettle: (run) => {
      const parentThreadId = run.parentThreadId;
      if (!useChatStore.getState().threads[parentThreadId]) return;
      const engine = engines.get(parentThreadId);
      if (!engine) return;
      const notice = agentNoticeFor(run);
      engine.appendAgentNotice(parentThreadId, notice.text, run.runId, notice.report);
    },
  })

  const parentThreadOf = async (runId: string): Promise<string | undefined> =>
    agentRunStore.get(runId)?.parentThreadId ?? (await agentPersistence.load(runId))?.parentThreadId

  const deps: EngineDeps = {
    getSettings,
    skillRegistry,
    toolRegistry,
    threadStore,
    agentPortsFor: (context) => createAgentPorts(agentRuntime, context),
    activeAgentsFor: (threadId) => agentRuntime.activeForThread(threadId),
    get workspace() {
      return getWorkspace() ?? undefined
    },
    get codeRunner() {
      return runnerSource.getRunners().js
    },
    get sandbox() {
      return sandboxControlPort()
    },
    get preview() {
      return previewPort()
    },
    get rag() {
      return ragPort()
    },
    mcp: mcpResourcePort,
    journalFor: (threadId) => workspaceJournalStore.forThread(threadId),
    memory: memoryPortFor,
    terminal,
  }

  const engines = new Map<string, ChatEngine>()

  function engineFor(threadId: string): ChatEngine {
    let engine = engines.get(threadId)
    if (!engine) {
      engine = createEngine(deps)
      engines.set(threadId, engine)
    }
    return engine
  }

  function disposeThread(threadId: string, options: { deleted?: boolean } = {}): void {
    agentRuntime.abortThread(threadId)
    if (options.deleted) terminal.killOwned({ threadId }).catch(() => undefined)
    const engine = engines.get(threadId)
    if (!engine) return
    engine.dispose()
    engines.delete(threadId)
  }

  function dispose(): void {
    agentRuntime.dispose()
    for (const threadId of [...engines.keys()]) disposeThread(threadId)
    // Persist any debounced journal writes before the session tears down.
    void workspaceJournalStore.flushAll()
    workspaceJournal.clear()
    unsubVault?.()
    unsubWorkspace?.()
    unsubFolder?.()
    unsubThread?.()
    unsubVault = null
    unsubWorkspace = null
    unsubFolder = null
    unsubThread = null
    manager?.dispose()
    ragPortInstance?.dispose()
    ragPortInstance = undefined
    unbindMcpTools?.()
    unbindMcpTools = null
    void mcp.dispose()
    terminal.dispose()
  }

  return {
    skillRegistry,
    toolRegistry,
    mcp,
    mcpResources: mcpResourcePort,
    startMcp,
    terminal,
    startTerminal,
    agentProfiles,
    threadStore,
    runnerSource,
    engineFor,
    disposeThread,
    dispose,
    cancelAgentRun: (runId) => agentRuntime.cancel(runId),
    steerAgentRun: (runId, text) => {
      // The live record knows the run's owning conversation; the runtime then
      // re-checks that ownership before enqueuing.
      const parentThreadId = agentRunStore.get(runId)?.parentThreadId
      if (parentThreadId === undefined) return false
      return agentRuntime.steer(parentThreadId, runId, text)
    },
    stopAgentRun: (runId) => {
      const parentThreadId = agentRunStore.get(runId)?.parentThreadId
      if (parentThreadId === undefined) return false
      return agentRuntime.stop(parentThreadId, runId)
    },
    agentRunChanges: async (runId) => {
      const parentThreadId = await parentThreadOf(runId)
      if (parentThreadId === undefined) return { changes: [], expired: false }
      const journal = await workspaceJournalStore.forThread(parentThreadId)
      return {
        changes: journal.changesForRun(runId),
        expired: journal.planRunRevert(runId).expired === true,
      }
    },
    revertAgentRun: async (runId) => {
      const run = agentRunStore.get(runId) ?? (await agentPersistence.load(runId))
      if (!run) return { error: `No run ${runId} is available.` }
      if (run.status === 'running') return { error: 'Stop the run before reverting its changes.' }
      const workspace = getWorkspace()
      if (!workspace) return { error: 'Open the workspace folder before reverting a run.' }
      const journal = await workspaceJournalStore.forThread(run.parentThreadId)
      return applyRunRevert(workspace, journal, runId, run.label ?? runId)
    },
    continueAgentRun: async (runId, text) => {
      const parentThreadId = await parentThreadOf(runId)
      if (parentThreadId === undefined) {
        return { status: 'invalid_input', message: `No run ${runId} is available to continue.` }
      }
      const parent =
        useChatStore.getState().threads[parentThreadId] ?? (await threadStore.loadThread(parentThreadId))
      if (!parent) {
        return { status: 'invalid_input', message: 'The conversation that owns this run is gone.' }
      }
      const context: AgentParentContext = {
        parentThreadId,
        mode: parent.mode ?? 'editing',
        providerId: parent.config.providerId,
        ...(parent.config.modelId !== undefined ? { modelId: parent.config.modelId } : {}),
        systemInstruction: parent.config.systemInstruction,
        toolNames: [],
      }
      return agentRuntime.continue(context, runId, text, { background: true })
    },
    getWorkspace,
    setWorkspace(fs) {
      useWorkspaceStore.getState().setFs(fs)
    },
    sandbox: () => manager,
    builtinProviders(config) {
      const skills = config ? skillRegistry.resolve(config.enabledSkills) : []
      const memoryStore = useMemoryStore.getState()
      const ports = {
        rag: ragPort(),
        mcp: mcpResourcePort,
        workspace: getWorkspace() ?? undefined,
        codeRunner: runnerSource.getRunners().js,
        sandbox: sandboxControlPort(),
        preview: previewPort(),
        skills: createSkillLoadPort(skills),
        ...(config
          ? { plan: { get: () => [], set: async () => {} } }
          : {}),
        ...(memoryStore.status === 'ready'
          ? { memory: bindMemoryPort({ store: memoryStore, scopeId: null, handle: null }) }
          : {}),
        terminal: { port: terminal, threadId: '' },
        ...createAdminPorts({ skillRegistry, toolRegistry }),
      }
      return [
        workspaceToolProvider,
        checkProvider,
        historyProvider,
        codeProvider,
        sandboxControlProvider,
        modeProvider,
        skillProvider,
        planProvider,
        skillManagementProvider,
        toolManagementProvider,
        previewProvider,
        toolGuideProvider,
        ragProvider,
        agentsProvider,
        memoryProvider,
        mcpResourceProvider,
        terminalProvider,
      ]
        .flatMap((provider) =>
          provider.names.map((name) => ({
            name,
            available: provider.isAvailable(ports),
            ...describeBuiltinTool(provider, name, ports),
          })),
        )
        .sort((a, b) => a.name.localeCompare(b.name))
    },
  }
}
