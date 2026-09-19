import type { ChatEngine, EngineDeps, ThreadStore } from '../chat/engine'
import { createEngine } from '../chat/engine'
import { deleteThread, listThreads, loadThread, saveThread } from '../chat/persistence'
import { createSandboxManager } from '../sandbox/manager'
import type { SandboxManager } from '../sandbox/manager'
import { createVaultSkillEnablement } from '../skills/enablement'
import type { SkillEnablementPort } from '../skills/enablement'
import { SkillRegistry } from '../skills/registry'
import { createCodeToolProvider } from '../tools/builtin/code'
import type { CodeRunnerSource } from '../tools/builtin/code'
import { workspaceToolProvider } from '../tools/builtin/workspace'
import { ToolRegistry } from '../tools/registry'
import { useVaultStore } from '../vault/store'
import {
  DEFAULT_SANDBOX_JS_TIMEOUT_MS,
  DEFAULT_SANDBOX_PY_TIMEOUT_MS,
} from '../vault/settings'
import type { SandboxSettings, Settings } from '../vault/settings'
import type { WorkspaceFs } from '../workspace/fs'
import { useWorkspaceStore } from './workspace-state'

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
  /** Builtin tool names with their current availability for the given ports. */
  builtinProviders(): Array<{ name: string; available: boolean }>
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

  let manager: SandboxManager | null = null
  let unsubVault: (() => void) | null = null
  let unsubWorkspace: (() => void) | null = null

  if (options.runnerSource) {
    manager = null
  } else {
    manager =
      options.sandboxManager ??
      createSandboxManager({
        settings: currentSandbox(),
        workspace: getWorkspace() ?? undefined,
      })
    // Rebuild the workspace-bound pair when the folder changes; apply
    // settings-driven timeout changes without rebuilding on unrelated writes.
    unsubWorkspace = useWorkspaceStore.subscribe((state, previous) => {
      if (state.fs === previous.fs || !manager) return
      manager.dispose()
      manager = createSandboxManager({
        settings: currentSandbox(),
        workspace: state.fs ?? undefined,
      })
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

  if (!options.toolRegistry) {
    toolRegistry.registerProvider(workspaceToolProvider)
    toolRegistry.registerProvider(codeProvider)
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
    unsubVault?.()
    unsubWorkspace?.()
    unsubVault = null
    unsubWorkspace = null
    manager?.dispose()
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
    builtinProviders() {
      const ports = {
        workspace: getWorkspace() ?? undefined,
        codeRunner: runnerSource.getRunners().js,
      }
      return [workspaceToolProvider, codeProvider]
        .flatMap((provider) =>
          provider.names.map((name) => ({ name, available: provider.isAvailable(ports) })),
        )
        .sort((a, b) => a.name.localeCompare(b.name))
    },
  }
}
