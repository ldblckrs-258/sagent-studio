import { jsonSchema, tool } from 'ai'
import { isSkillManifest } from '../../skills/schema'
import { toolFail, toolOk, wrapToolExecute } from '../result'
import {
  ToolNameConflictError,
  ToolNotFoundError,
  ToolRuntimeUnavailableError,
  ToolSchemaError,
} from '../types'
import type { SkillAdminEntry, SkillDraft, ToolProvider } from '../types'

const NAMES = ['list_skills', 'create_skill', 'update_skill', 'delete_skill'] as const

const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i

type SkillSource = 'vault' | 'workspace'

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function readSource(record: Record<string, unknown>): SkillSource | undefined | null {
  const value = record.source
  if (value === undefined) return undefined
  if (value === 'vault' || value === 'workspace') return value
  return null
}

function readAllowedTools(record: Record<string, unknown>): string[] | undefined {
  if (record.allowedTools === undefined) return undefined
  if (!Array.isArray(record.allowedTools)) return undefined
  if (!record.allowedTools.every((entry) => typeof entry === 'string')) return undefined
  return record.allowedTools as string[]
}

function project(entry: SkillAdminEntry) {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    source: entry.source,
    enabled: entry.enabled,
    allowedTools: entry.allowedTools,
  }
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

function buildDraft(record: Record<string, unknown>): SkillDraft | { error: string } {
  const id = readString(record, 'id') ?? ''
  if (!SKILL_ID_PATTERN.test(id)) {
    return { error: 'id must match ^[a-z0-9][a-z0-9._-]{0,63}$.' }
  }
  const name = readString(record, 'name') ?? ''
  if (name.length === 0) return { error: 'name must be a non-empty string.' }
  const instructions = readString(record, 'instructions')
  if (instructions === undefined) return { error: 'instructions must be a string.' }
  const allowedTools = readAllowedTools(record)
  if (record.allowedTools !== undefined && allowedTools === undefined) {
    return { error: 'allowedTools must be an array of tool names.' }
  }
  return {
    id,
    name,
    description: readString(record, 'description') ?? '',
    instructions,
    allowedTools: allowedTools ?? [],
  }
}

export function createSkillManagementProvider(): ToolProvider {
  return {
    names: NAMES,
    isAvailable: (ports) => ports.skillAdmin !== undefined,
    create(name, ports) {
      switch (name) {
        case 'list_skills':
          return tool({
            description:
              'List every registered skill with its id, name, description, source, enabled state, and allowed tools.',
            inputSchema: jsonSchema<{ source?: SkillSource }>({
              type: 'object',
              properties: { source: { type: 'string', enum: ['vault', 'workspace'] } },
            } as Parameters<typeof jsonSchema>[0]),
            execute: wrapToolExecute(async (input) => {
              const port = ports.skillAdmin
              if (!port) throw new ToolRuntimeUnavailableError(name)
              const source = readSource(asRecord(input))
              if (source === null) {
                return toolFail('invalid_input', 'source must be "vault" or "workspace".')
              }
              const entries = port
                .list()
                .filter((entry) => source === undefined || entry.source === source)
                .map(project)
              return toolOk({ skills: entries, count: entries.length })
            }),
          })
        case 'create_skill':
          return tool({
            description:
              'Create a vault skill from an id, name, instructions, and optional description/allowed tools. New skills are disabled until enabled.',
            inputSchema: jsonSchema<{
              id: string
              name: string
              description?: string
              instructions: string
              allowedTools?: string[]
              enabled?: boolean
            }>({
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string' },
                instructions: { type: 'string' },
                allowedTools: { type: 'array', items: { type: 'string' } },
                enabled: { type: 'boolean' },
              },
              required: ['id', 'name', 'instructions'],
            } as Parameters<typeof jsonSchema>[0]),
            execute: wrapToolExecute(async (input) => {
              const port = ports.skillAdmin
              if (!port) throw new ToolRuntimeUnavailableError(name)
              const record = asRecord(input)
              const draft = buildDraft(record)
              if ('error' in draft) return toolFail('invalid_input', draft.error)
              const enabled = record.enabled
              if (enabled !== undefined && typeof enabled !== 'boolean') {
                return toolFail('invalid_input', 'enabled must be a boolean when present.')
              }
              if (!isSkillManifest({ ...draft, source: 'vault' })) {
                return toolFail('invalid_input', 'The skill definition is malformed.')
              }
              if (port.exists(draft.id)) {
                return toolFail('conflict', `A skill with id "${draft.id}" already exists.`)
              }
              try {
                const entry = await port.create(draft, enabled === undefined ? {} : { enabled })
                return toolOk(project(entry))
              } catch (error) {
                return mapPortError(error) ?? rethrowUnmapped(error)
              }
            }),
          })
        case 'update_skill':
          return tool({
            description:
              'Patch fields of an existing vault skill by id. Only the supplied fields change; workspace skills are read-only.',
            inputSchema: jsonSchema<{
              id: string
              source?: SkillSource
              name?: string
              description?: string
              instructions?: string
              allowedTools?: string[]
              enabled?: boolean
            }>({
              type: 'object',
              properties: {
                id: { type: 'string' },
                source: { type: 'string', enum: ['vault', 'workspace'] },
                name: { type: 'string' },
                description: { type: 'string' },
                instructions: { type: 'string' },
                allowedTools: { type: 'array', items: { type: 'string' } },
                enabled: { type: 'boolean' },
              },
              required: ['id'],
            } as Parameters<typeof jsonSchema>[0]),
            execute: wrapToolExecute(async (input) => {
              const port = ports.skillAdmin
              if (!port) throw new ToolRuntimeUnavailableError(name)
              const record = asRecord(input)
              const id = readString(record, 'id') ?? ''
              if (id.length === 0) return toolFail('invalid_input', 'id must be a non-empty string.')
              const source = readSource(record)
              if (source === null) {
                return toolFail('invalid_input', 'source must be "vault" or "workspace".')
              }
              if (source === 'workspace') {
                return toolFail('permission_denied', 'Workspace skills are read-only.')
              }
              const target: SkillSource = source ?? 'vault'
              if (!port.get(id, target)) {
                return toolFail('not_found', `No skill "${id}" (${target}) is registered.`)
              }

              const patch: Partial<SkillDraft> = {}
              const suppliedName = readString(record, 'name')
              if (suppliedName !== undefined) patch.name = suppliedName
              const suppliedDescription = readString(record, 'description')
              if (suppliedDescription !== undefined) patch.description = suppliedDescription
              const suppliedInstructions = readString(record, 'instructions')
              if (suppliedInstructions !== undefined) patch.instructions = suppliedInstructions
              const suppliedAllowed = readAllowedTools(record)
              if (record.allowedTools !== undefined && suppliedAllowed === undefined) {
                return toolFail('invalid_input', 'allowedTools must be an array of tool names.')
              }
              if (suppliedAllowed !== undefined) patch.allowedTools = suppliedAllowed
              const enabled = record.enabled
              if (enabled !== undefined && typeof enabled !== 'boolean') {
                return toolFail('invalid_input', 'enabled must be a boolean when present.')
              }
              if (Object.keys(patch).length === 0 && enabled === undefined) {
                return toolFail('invalid_input', 'Provide at least one field to update.')
              }
              try {
                const entry = await port.update(
                  { id, source: target },
                  patch,
                  enabled === undefined ? {} : { enabled },
                )
                return toolOk(project(entry))
              } catch (error) {
                return mapPortError(error) ?? rethrowUnmapped(error)
              }
            }),
          })
        case 'delete_skill':
          return tool({
            description:
              'Delete a vault skill by id. Workspace skills are read-only and cannot be deleted.',
            inputSchema: jsonSchema<{ id: string; source?: SkillSource }>({
              type: 'object',
              properties: {
                id: { type: 'string' },
                source: { type: 'string', enum: ['vault', 'workspace'] },
              },
              required: ['id'],
            } as Parameters<typeof jsonSchema>[0]),
            execute: wrapToolExecute(async (input) => {
              const port = ports.skillAdmin
              if (!port) throw new ToolRuntimeUnavailableError(name)
              const record = asRecord(input)
              const id = readString(record, 'id') ?? ''
              if (id.length === 0) return toolFail('invalid_input', 'id must be a non-empty string.')
              const source = readSource(record)
              if (source === null) {
                return toolFail('invalid_input', 'source must be "vault" or "workspace".')
              }
              if (source === 'workspace') {
                return toolFail('permission_denied', 'Workspace skills are read-only.')
              }
              const target: SkillSource = source ?? 'vault'
              if (!port.get(id, target)) {
                return toolFail('not_found', `No skill "${id}" (${target}) is registered.`)
              }
              try {
                await port.remove({ id, source: target })
                return toolOk({ id, deleted: true })
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
