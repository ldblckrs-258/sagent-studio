import { jsonSchema, tool } from 'ai'
import { toolFail, toolOk, wrapToolExecute } from '../result'
import { assertHttpDefinition } from '../store'
import {
  ToolNameConflictError,
  ToolNotFoundError,
  ToolRuntimeUnavailableError,
  ToolSchemaError,
  assertPlainSchema,
  isToolDefinition,
  validateToolName,
} from '../types'
import type {
  HttpRequestTemplate,
  HttpToolDefinition,
  JsonSchemaObject,
  SandboxJsToolDefinition,
  ToolDefinition,
  ToolProvider,
} from '../types'

const NAMES = ['list_user_tools', 'create_tool', 'update_tool', 'delete_tool'] as const

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function buildDefinition(record: Record<string, unknown>): ToolDefinition | { error: string } {
  const kind = record.kind
  if (kind !== 'sandbox-js' && kind !== 'http') {
    return { error: 'kind must be "sandbox-js" or "http".' }
  }
  const name = readString(record, 'name') ?? ''
  if (name.length === 0) return { error: 'name must be a non-empty string.' }
  const description = readString(record, 'description') ?? ''
  if (!isPlainObject(record.inputSchema)) return { error: 'inputSchema must be a JSON object.' }
  const enabled = record.enabled === undefined ? false : record.enabled
  if (typeof enabled !== 'boolean') {
    return { error: 'enabled must be a boolean when present.' }
  }
  const timeoutMs = record.timeoutMs
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0)
  ) {
    return { error: 'timeoutMs must be a positive integer.' }
  }
  const inputSchema = record.inputSchema as JsonSchemaObject

  if (kind === 'sandbox-js') {
    const source = record.source
    if (typeof source !== 'string') {
      return { error: 'A sandbox-js tool needs source text.' }
    }
    const definition: SandboxJsToolDefinition = {
      kind,
      name,
      description,
      inputSchema,
      source,
      enabled,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    }
    return definition
  }

  if (!isPlainObject(record.request)) {
    return { error: 'An http tool needs a request object.' }
  }
  const definition: HttpToolDefinition = {
    kind: 'http',
    name,
    description,
    inputSchema,
    request: record.request as unknown as HttpRequestTemplate,
    enabled,
  }
  return definition
}

function assertValid(definition: ToolDefinition): void {
  if (!isToolDefinition(definition)) throw new ToolSchemaError('The tool definition is malformed.')
  validateToolName(definition.name)
  assertPlainSchema(definition.inputSchema)
  if (definition.kind === 'sandbox-js') {
    if (typeof definition.source !== 'string') {
      throw new ToolSchemaError('A sandbox-js tool needs source text.')
    }
    return
  }
  assertHttpDefinition(definition)
}

function mapPortError(error: unknown) {
  if (error instanceof ToolNameConflictError) return toolFail('conflict', error.message)
  if (error instanceof ToolNotFoundError) return toolFail('not_found', error.message)
  if (error instanceof ToolSchemaError) return toolFail('invalid_input', error.message)
  return null
}

function rethrowUnmapped(error: unknown): never {
  throw error
}

export function createToolManagementProvider(): ToolProvider {
  return {
    names: NAMES,
    isAvailable: (ports) => ports.toolAdmin !== undefined,
    create(name, ports) {
      switch (name) {
        case 'list_user_tools':
          return tool({
            description:
              'List every custom user tool with its name, kind, description, enabled state, and a one-line summary.',
            inputSchema: jsonSchema({ type: 'object', properties: {} } as Parameters<
              typeof jsonSchema
            >[0]),
            execute: wrapToolExecute(async () => {
              const port = ports.toolAdmin
              if (!port) throw new ToolRuntimeUnavailableError(name)
              const tools = port.list()
              return toolOk({ tools, count: tools.length })
            }),
          })
        case 'create_tool':
          return tool({
            description:
              'Create a custom user tool (sandbox-js or http). New tools are disabled until enabled.',
            inputSchema: jsonSchema<{
              kind: 'sandbox-js' | 'http'
              name: string
              description?: string
              inputSchema: JsonSchemaObject
              enabled?: boolean
              source?: string
              timeoutMs?: number
              request?: HttpRequestTemplate
            }>({
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['sandbox-js', 'http'] },
                name: { type: 'string' },
                description: { type: 'string' },
                inputSchema: { type: 'object' },
                enabled: { type: 'boolean' },
                source: { type: 'string' },
                timeoutMs: { type: 'number' },
                request: { type: 'object' },
              },
              required: ['kind', 'name', 'inputSchema'],
            } as Parameters<typeof jsonSchema>[0]),
            execute: wrapToolExecute(async (input) => {
              const port = ports.toolAdmin
              if (!port) throw new ToolRuntimeUnavailableError(name)
              const built = buildDefinition(asRecord(input))
              if ('error' in built) return toolFail('invalid_input', built.error)
              try {
                assertValid(built)
              } catch (error) {
                return mapPortError(error) ?? rethrowUnmapped(error)
              }
              if (port.hasTool(built.name)) {
                return toolFail('conflict', `A tool named "${built.name}" already exists.`)
              }
              try {
                return toolOk(await port.create(built))
              } catch (error) {
                return mapPortError(error) ?? rethrowUnmapped(error)
              }
            }),
          })
        case 'update_tool':
          return tool({
            description:
              'Update a custom user tool by its current name. Any field can change; supplying a different name renames the tool. Kind is immutable.',
            inputSchema: jsonSchema<{
              from: string
              name?: string
              description?: string
              inputSchema?: JsonSchemaObject
              enabled?: boolean
              source?: string
              timeoutMs?: number
              request?: HttpRequestTemplate
            }>({
              type: 'object',
              properties: {
                from: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string' },
                inputSchema: { type: 'object' },
                enabled: { type: 'boolean' },
                source: { type: 'string' },
                timeoutMs: { type: 'number' },
                request: { type: 'object' },
              },
              required: ['from'],
            } as Parameters<typeof jsonSchema>[0]),
            execute: wrapToolExecute(async (input) => {
              const port = ports.toolAdmin
              if (!port) throw new ToolRuntimeUnavailableError(name)
              const record = asRecord(input)
              const from = readString(record, 'from') ?? ''
              if (from.length === 0) {
                return toolFail('invalid_input', 'from must be a non-empty tool name.')
              }
              const current = port.get(from)
              if (!current) {
                return toolFail('not_found', `No user tool named "${from}".`)
              }
              const merged: Record<string, unknown> = {
                kind: current.kind,
                name: record.name ?? current.name,
                description: record.description ?? current.description,
                inputSchema: record.inputSchema ?? current.inputSchema,
                enabled: record.enabled ?? current.enabled,
              }
              if (current.kind === 'sandbox-js') {
                merged.source = record.source ?? current.source
                merged.timeoutMs = record.timeoutMs ?? current.timeoutMs
              } else {
                merged.request = record.request ?? current.request
              }
              const built = buildDefinition(merged)
              if ('error' in built) return toolFail('invalid_input', built.error)
              try {
                assertValid(built)
              } catch (error) {
                return mapPortError(error) ?? rethrowUnmapped(error)
              }
              if (built.name !== from && port.hasTool(built.name)) {
                return toolFail('conflict', `A tool named "${built.name}" already exists.`)
              }
              try {
                return toolOk(await port.update(from, built))
              } catch (error) {
                return mapPortError(error) ?? rethrowUnmapped(error)
              }
            }),
          })
        case 'delete_tool':
          return tool({
            description: 'Delete a custom user tool by name.',
            inputSchema: jsonSchema<{ name: string }>({
              type: 'object',
              properties: { name: { type: 'string' } },
              required: ['name'],
            } as Parameters<typeof jsonSchema>[0]),
            execute: wrapToolExecute(async (input) => {
              const port = ports.toolAdmin
              if (!port) throw new ToolRuntimeUnavailableError(name)
              const toolName = readString(asRecord(input), 'name') ?? ''
              if (toolName.length === 0) {
                return toolFail('invalid_input', 'name must be a non-empty string.')
              }
              if (!port.get(toolName)) {
                return toolFail('not_found', `No user tool named "${toolName}".`)
              }
              try {
                await port.remove(toolName)
                return toolOk({ name: toolName, deleted: true })
              } catch (error) {
                return mapPortError(error) ?? rethrowUnmapped(error)
              }
            }),
          })
        default:
          throw new ToolNotFoundError(name)
      }
    },
  }
}
