import { jsonSchema, tool } from 'ai'
import { normalizePlanItems, planCounts, planTextChanges } from '../../chat/plan'
import { toolFail, toolOk, wrapToolExecute } from '../result'
import { ToolNotFoundError, ToolRuntimeUnavailableError } from '../types'
import type { ToolProvider } from '../types'

const NAMES = ['update_plan'] as const

export function createPlanToolProvider(): ToolProvider {
  return {
    names: NAMES,
    isAvailable: (ports) => ports.plan !== undefined,
    create(name, ports) {
      switch (name) {
        case 'update_plan':
          return tool({
            description:
              'Replace the conversation plan with a full list of items. Send the entire list every time; the list you send becomes the plan. Ids are append-only handles: keep an existing id\'s text stable and give a genuinely new step a new id, or the response reports the retexting as a warning.',
            inputSchema: jsonSchema<{
              items: Array<{ id?: string; text: string; status?: string }>
            }>({
              type: 'object',
              properties: {
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      text: { type: 'string' },
                      status: {
                        type: 'string',
                        enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                      },
                    },
                    required: ['text'],
                  },
                },
              },
              required: ['items'],
            } as Parameters<typeof jsonSchema>[0]),
            execute: wrapToolExecute(async (input) => {
              const port = ports.plan
              if (!port) throw new ToolRuntimeUnavailableError(name)
              const rawItems =
                typeof input === 'object' && input !== null
                  ? (input as { items?: unknown }).items
                  : undefined
              const parsed = normalizePlanItems(rawItems)
              if (!parsed.ok) {
                const current = port.get()
                return toolFail('invalid_input', parsed.message, {
                  ...(current.length > 0
                    ? { hint: `Current plan ids: ${current.map((item) => item.id).join(', ')}.` }
                    : {}),
                })
              }
              const previous = port.get()
              const changes = planTextChanges(previous, parsed.items)
              try {
                await port.set(parsed.items)
              } catch (error) {
                return toolFail(
                  'runtime_error',
                  error instanceof Error ? error.message : 'The plan could not be saved.',
                )
              }
              return toolOk({
                items: parsed.items,
                counts: planCounts(parsed.items),
                ...(changes.length > 0
                  ? {
                      notice:
                        'Some item ids have new text; ids are append-only, so use a new id for a new step.',
                      changes,
                    }
                  : {}),
              })
            }),
          })
        default:
          throw new ToolNotFoundError(name)
      }
    },
  }
}
