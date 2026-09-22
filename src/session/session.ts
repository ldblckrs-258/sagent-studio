import type { ChatEngine, EngineDeps, ThreadStore } from '../chat/engine'
import { createEngine, createSkillLoadPort } from '../chat/engine'
import type { ThreadConfig } from '../chat/types'
import { deleteThread, listThreads, loadThread, saveThread } from '../chat/persistence'
import { useChatStore } from '../chat/store'
import { labelConversation } from '../chat/threads'
import { createEmbedder } from '../ai/embedder'
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
import { createCheckToolProvider } from '../tools/builtin/check'
import { createCodeToolProvider } from '../tools/builtin/code'
import type { CodeRunnerSource } from '../tools/builtin/code'
import { createHistoryToolProvider } from '../tools/builtin/history'
import { createModeToolProvider } from '../tools/builtin/mode'
import { createPlanToolProvider } from '../tools/builtin/plan'
import { createPreviewToolProvider } from '../tools/builtin/preview'
import { createRagToolProvider } from '../tools/builtin/rag'
import { createSandboxControlProvider } from '../tools/builtin/sandbox-control'
import { createSkillManagementProvider } from '../tools/builtin/skill-management'
import { createSkillToolProvider } from '../tools/builtin/skills'
import { createToolGuideProvider } from '../tools/builtin/tool-guide'
import { createToolManagementProvider } from '../tools/builtin/tool-management'
import type { JsonSchemaObject, PreviewPort, SandboxControlPort, ToolProvider, ToolRuntimePorts } from '../tools/types'
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
  threadStore: ThreadStore
  runnerSource: CodeRunnerSource
  engineFor(threadId: string): ChatEngine
  disposeThread(threadId: string): void
  dispose(): void
  getWorkspace(): WorkspaceFs | null
  setWorkspace(fs: WorkspaceFs | null): void
  /** Builtin tools with availability and introspection details for the given thread config's ports. */
  builtinProviders(config?: ThreadConfig): BuiltinProviderInfo[]
  sandbox(): SandboxManager | null
}

export interface SessionOptions {
  skillRegistry?: SkillRegistry
  skillEnablement?: SkillEnablementPort
  toolRegistry?: ToolRegistry
  threadStore?: ThreadStore
  runnerSource?: CodeRunnerSource
  sandboxManager?: SandboxManager
  getSettings?: () => Settings | null
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
  unsubFolder = useWorkspaceStore.subscribe((state, previous) => {
    if (state.fs === previous.fs) return
    workspaceJournal.clear()
    syncWorkspaceLabel(state.folderName)
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
  }

  const deps: EngineDeps = {
    getSettings,
    skillRegistry,
    toolRegistry,
    threadStore,
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
    journalFor: (threadId) => workspaceJournalStore.forThread(threadId),
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

  function disposeThread(threadId: string): void {
    const engine = engines.get(threadId)
    if (!engine) return
    engine.dispose()
    engines.delete(threadId)
  }

  function dispose(): void {
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
  }

  return {
    skillRegistry,
    toolRegistry,
    threadStore,
    runnerSource,
    engineFor,
    disposeThread,
    dispose,
    getWorkspace,
    setWorkspace(fs) {
      useWorkspaceStore.getState().setFs(fs)
    },
    sandbox: () => manager,
    builtinProviders(config) {
      const skills = config ? skillRegistry.resolve(config.enabledSkills) : []
      const ports = {
        rag: ragPort(),
        workspace: getWorkspace() ?? undefined,
        codeRunner: runnerSource.getRunners().js,
        sandbox: sandboxControlPort(),
        preview: previewPort(),
        skills: createSkillLoadPort(skills),
        ...(config
          ? { plan: { get: () => [], set: async () => {} } }
          : {}),
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
