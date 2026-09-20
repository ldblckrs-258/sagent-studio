import { jsonSchema, tool } from 'ai'
import type { CodeRunner, RunResult } from '../../sandbox/types'
import { toolFail, toolOk, wrapToolExecute } from '../result'
import { ToolNotFoundError } from '../types'
import type { ToolProvider } from '../types'

const NAMES = ['run_js', 'run_python'] as const

function sourceSchema(): Parameters<typeof jsonSchema>[0] {
  return {
    type: 'object',
    properties: { source: { type: 'string' } },
    required: ['source'],
  } as Parameters<typeof jsonSchema>[0]
}

function readSource(input: unknown): string {
  if (typeof input === 'object' && input !== null) {
    const source = (input as { source?: unknown }).source
    if (typeof source === 'string') return source
  }
  return ''
}

export interface CodeToolRunners {
  js: CodeRunner
  python: CodeRunner
}

/**
 * A live source for the sandbox runners. The provider reads it on every
 * availability check and every tool call, so a settings-driven runner swap or
 * enable toggle takes effect without re-registering the provider.
 */
export interface CodeRunnerSource {
  getRunners(): CodeToolRunners
  isEnabled(): boolean
}

function fromRunResult(result: RunResult) {
  if (result.error !== undefined) return toolFail('runtime_error', result.error, { value: result })
  return toolOk(result)
}

export function createCodeToolProvider(source: CodeRunnerSource): ToolProvider {
  return {
    names: NAMES,
    isAvailable: () => source.isEnabled(),
    create(name, ports) {
      const journal = ports.journal
      switch (name) {
        case 'run_js':
          return tool({
            description:
              'Run JavaScript in an isolated worker and return its stdout, stderr, and result. The body receives a `console` and an `fs` object; use `await fs.readFile(path)`, `await fs.writeFile(path, data)`, or `fs.list(path)` (which resolves to a JSON string — parse it before use) to touch the open workspace folder, and `return` a value to surface it as the result. There is no `require`, `process`, or Node `fs`. The bridge requires an open workspace folder; without one, `fs` calls reject.',
            inputSchema: jsonSchema<{ source: string }>(sourceSchema()),
            execute: wrapToolExecute(async (input) =>
              fromRunResult(await source.getRunners().js.run(readSource(input), { ...(journal ? { journal } : {}) })),
            ),
          })
        case 'run_python':
          return tool({
            description:
              'Run Python (Pyodide) in an isolated worker and return its stdout, stderr, and result. Import the workspace bridge with `import workspace`, then call `workspace.readFile(path)`, `workspace.writeFile(path, data)`, or `workspace.list(path)`; these return JavaScript-backed awaitables, so await them. Print or return a value to surface it as the result. The bridge requires an open workspace folder; without one, bridge calls reject.',
            inputSchema: jsonSchema<{ source: string }>(sourceSchema()),
            execute: wrapToolExecute(async (input) =>
              fromRunResult(await source.getRunners().python.run(readSource(input), { ...(journal ? { journal } : {}) })),
            ),
          })
        default:
          throw new ToolNotFoundError(name)
      }
    },
  }
}
