import { jsonSchema, tool } from 'ai'
import type { ChatMode } from '../../chat/types'
import { toolFail, toolOk, wrapToolExecute } from '../result'
import { ToolNotFoundError, ToolRuntimeUnavailableError } from '../types'
import type { ToolProvider } from '../types'

const NAMES = ['change_mode'] as const

function readMode(input: unknown): ChatMode | null {
  if (typeof input !== 'object' || input === null) return null
  const value = (input as { mode?: unknown }).mode
  return value === 'read_only' || value === 'editing' || value === 'god' ? value : null
}

/**
 * The always-asking mode tool. It is never gated by the mode ceiling and is
 * mapped to `'user-approval'` in every mode, so the model can never raise its
 * own ceiling without an explicit user accept.
 */
export function createModeToolProvider(): ToolProvider {
  return {
    names: NAMES,
    isAvailable: () => true,
    create(name, ports) {
      switch (name) {
        case 'change_mode':
          return tool({
            description:
              'Request a change of the conversation permission mode. This always requires user approval. The current mode is stated in the system prompt under "Permission mode".',
            inputSchema: jsonSchema<{ mode: ChatMode }>({
              type: 'object',
              properties: { mode: { type: 'string', enum: ['read_only', 'editing', 'god'] } },
              required: ['mode'],
            } as Parameters<typeof jsonSchema>[0]),
            execute: wrapToolExecute(async (input) => {
              const port = ports.mode
              if (!port) throw new ToolRuntimeUnavailableError(name)
              const mode = readMode(input)
              if (mode === null) {
                return toolFail('invalid_input', 'mode must be read_only, editing, or god.', {
                  hint: 'Pass one of the three supported modes.',
                })
              }
              await port.setMode(mode)
              return toolOk({ mode })
            }),
          })
        default:
          throw new ToolNotFoundError(name)
      }
    },
  }
}
