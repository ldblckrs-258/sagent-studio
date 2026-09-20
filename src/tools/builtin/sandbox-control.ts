import { jsonSchema, tool } from 'ai'
import { toolFail, toolOk, wrapToolExecute } from '../result'
import { ToolNotFoundError, ToolRuntimeUnavailableError } from '../types'
import type { SandboxControlPort, ToolProvider } from '../types'

export interface SandboxControlSource {
  isEnabled(): boolean
  getPort(): SandboxControlPort | undefined
}

const NAMES = ['reset_sandbox'] as const

type Language = 'js' | 'python'

function readLanguage(input: unknown): Language | undefined | null {
  if (typeof input !== 'object' || input === null) return undefined
  const value = (input as { language?: unknown }).language
  if (value === undefined) return undefined
  if (value === 'js' || value === 'python') return value
  return null
}

export function createSandboxControlProvider(source: SandboxControlSource): ToolProvider {
  return {
    names: NAMES,
    isAvailable: () => source.isEnabled(),
    create(name, ports) {
      switch (name) {
        case 'reset_sandbox':
          return tool({
            description:
              'Reset the sandbox session, terminating warm JavaScript and Python workers so the next run starts clean. This restarts the execution runtimes only; it never touches workspace files or their contents.',
            inputSchema: jsonSchema<{ language?: Language }>({
              type: 'object',
              properties: { language: { type: 'string', enum: ['js', 'python'] } },
            } as Parameters<typeof jsonSchema>[0]),
            execute: wrapToolExecute(async (input) => {
              const port = source.getPort() ?? ports.sandbox
              if (!port) throw new ToolRuntimeUnavailableError(name)
              const language = readLanguage(input)
              if (language === null) {
                return toolFail('invalid_input', 'language must be "js" or "python".', {
                  hint: 'Omit language to reset both runtimes.',
                })
              }
              port.reset(language)
              return toolOk({ reset: language === undefined ? ['js', 'python'] : [language] })
            }),
          })
        default:
          throw new ToolNotFoundError(name)
      }
    },
  }
}
