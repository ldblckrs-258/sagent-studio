import type { WorkspaceApi } from '../tools/types'
import type { SandboxSettings } from '../vault/settings'
import { JsRunner } from './js-runner'
import { PyRunner } from './py-runner'
import type { CodeRunner, RunResult } from './types'
import type { WorkerFactory } from './worker-factory'

export interface RunnerAvailability {
  js: boolean
  python: boolean
  reason?: string
}

export type SandboxLanguage = 'js' | 'python'

export interface SandboxRunnerPair {
  js: CodeRunner & { dispose(): void }
  python: CodeRunner & { dispose(): void }
}

export interface LastRun {
  language: SandboxLanguage
  result?: RunResult
  error?: string
}

export interface SandboxManager {
  /** Stable holder: object identity never changes; its fields do. */
  toolRunners(): SandboxRunnerPair
  consoleRunners(): SandboxRunnerPair
  availability(): RunnerAvailability
  lastRun(): LastRun | null
  run(
    language: SandboxLanguage,
    source: string,
    options?: { workspace?: boolean },
  ): Promise<RunResult>
  setSettings(sandbox: SandboxSettings): void
  dispose(): void
}

export interface SandboxManagerOptions {
  settings: SandboxSettings
  workspace?: WorkspaceApi
  workerFactory?: { js?: WorkerFactory; python?: WorkerFactory }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function buildPair(
  settings: SandboxSettings,
  workspace: WorkspaceApi | undefined,
  factories: { js?: WorkerFactory; python?: WorkerFactory },
): SandboxRunnerPair {
  return {
    js: new JsRunner({
      ...(factories.js ? { workerFactory: factories.js } : {}),
      ...(workspace ? { workspace } : {}),
      defaultTimeoutMs: settings.jsTimeoutMs,
    }),
    python: new PyRunner({
      ...(factories.python ? { workerFactory: factories.python } : {}),
      ...(workspace ? { workspace } : {}),
      defaultTimeoutMs: settings.pyTimeoutMs,
    }),
  }
}

/**
 * The single owner of both runner pairs: the workspace-bound pair for the
 * model-facing tools and the file-less pair for the scratchpad console.
 */
export function createSandboxManager(options: SandboxManagerOptions): SandboxManager {
  const factories = options.workerFactory ?? {}
  let settings = options.settings
  let toolPair = buildPair(settings, options.workspace, factories)
  let consolePair = buildPair(settings, undefined, factories)
  let last: LastRun | null = null
  let activeRuns = 0
  let rebuildPending = false

  const rebuild = () => {
    toolPair.js.dispose()
    toolPair.python.dispose()
    consolePair.js.dispose()
    consolePair.python.dispose()
    toolPair = buildPair(settings, options.workspace, factories)
    consolePair = buildPair(settings, undefined, factories)
  }

  return {
    toolRunners: () => toolPair,
    consoleRunners: () => consolePair,

    availability() {
      if (typeof Worker === 'undefined') {
        return { js: false, python: false, reason: 'Web Workers are unavailable in this browser.' }
      }
      return { js: true, python: true }
    },

    lastRun: () => last,

    async run(language, source, options = {}) {
      if (!settings.enabled) {
        const result: RunResult = {
          stdout: '',
          stderr: '',
          result: null,
          error: 'The sandbox is disabled.',
        }
        last = { language, result }
        return result
      }
      const pair = options.workspace ? toolPair : consolePair
      const runner = language === 'js' ? pair.js : pair.python
      const timeoutMs = language === 'js' ? settings.jsTimeoutMs : settings.pyTimeoutMs
      activeRuns += 1
      try {
        const result = await runner.run(source, { timeoutMs })
        last = { language, result }
        return result
      } catch (error) {
        const message = describe(error)
        last = { language, error: message }
        return { stdout: '', stderr: '', result: null, error: message }
      } finally {
        activeRuns -= 1
        // Only swap runners between runs; never terminate a live one.
        if (activeRuns === 0 && rebuildPending) {
          rebuildPending = false
          rebuild()
        }
      }
    },

    setSettings(next) {
      const timeoutChanged =
        next.jsTimeoutMs !== settings.jsTimeoutMs || next.pyTimeoutMs !== settings.pyTimeoutMs
      settings = next
      if (!timeoutChanged) return
      if (activeRuns > 0) {
        rebuildPending = true
        return
      }
      rebuild()
    },

    dispose() {
      toolPair.js.dispose()
      toolPair.python.dispose()
      consolePair.js.dispose()
      consolePair.python.dispose()
    },
  }
}
