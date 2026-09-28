import type { CallToolResult, Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'
import { jsonSchema, tool } from 'ai'
import type { ToolRegistry } from '../tools/registry'
import { toolFail, toolOk, wrapToolExecute } from '../tools/result'
import type { ToolResult } from '../tools/result'
import { assertPlainSchema } from '../tools/types'
import type { ExternalToolEntry, ExternalToolSkip } from '../tools/types'
import type { McpConnectionManager, McpServerView } from './manager'
import { serverSlug } from './types'

export const MCP_TOOL_PREFIX = 'mcp_'
export const MCP_DESCRIPTION_MAX = 2_000
export const MCP_RESULT_TEXT_MAX = 100_000
export const MCP_SCHEMA_MAX = 20_000
export const MCP_STRUCTURED_MAX = 100_000
export const MCP_CONTENT_ITEMS_MAX = 50
const TOOL_NAME_MAX = 64
const HASH_LENGTH = 6

export interface McpToolBinding {
  exposedName: string
  serverId: string
  toolName: string
}

export interface McpContentDescriptor {
  type: string
  mimeType?: string
  bytes?: number
  uri?: string
  name?: string
}

export interface McpToolOutput {
  text: string
  content?: McpContentDescriptor[]
  structuredContent?: Record<string, unknown>
}

function slugPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0').slice(0, HASH_LENGTH)
}

export function mcpToolPrefix(serverName: string): string {
  return `${MCP_TOOL_PREFIX}${serverSlug(serverName)}_`
}

export function mcpToolName(serverName: string, toolName: string): string {
  const prefix = mcpToolPrefix(serverName)
  const slug = slugPart(toolName) || 'tool'
  const full = `${prefix}${slug}`
  if (full.length <= TOOL_NAME_MAX) return full
  const room = TOOL_NAME_MAX - prefix.length - HASH_LENGTH - 1
  return `${prefix}${slug.slice(0, room).replace(/_$/, '')}_${shortHash(toolName)}`
}

function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding)
}

export function mapCallToolResult(result: CallToolResult): ToolResult<McpToolOutput> | ToolResult {
  const texts: string[] = []
  const content: McpContentDescriptor[] = []
  for (const part of result.content ?? []) {
    if (part.type === 'text') {
      texts.push(part.text)
    } else if (part.type === 'image' || part.type === 'audio') {
      content.push({ type: part.type, mimeType: part.mimeType, bytes: base64Bytes(part.data) })
    } else if (part.type === 'resource_link') {
      content.push({
        type: 'resource_link',
        uri: part.uri,
        name: part.name,
        ...(part.mimeType ? { mimeType: part.mimeType } : {}),
      })
    } else if (part.type === 'resource') {
      const resource = part.resource
      if ('text' in resource && typeof resource.text === 'string') {
        texts.push(`Resource ${resource.uri}:\n${resource.text}`)
      } else if ('blob' in resource && typeof resource.blob === 'string') {
        content.push({
          type: 'resource',
          uri: resource.uri,
          ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
          bytes: base64Bytes(resource.blob),
        })
      }
    }
  }
  const joined = texts.join('\n\n')
  let truncated = joined.length > MCP_RESULT_TEXT_MAX || content.length > MCP_CONTENT_ITEMS_MAX
  const text = joined.length > MCP_RESULT_TEXT_MAX ? joined.slice(0, MCP_RESULT_TEXT_MAX) : joined
  content.splice(MCP_CONTENT_ITEMS_MAX)
  if (result.isError) {
    return toolFail('runtime_error', text || 'The MCP tool reported an error without a message.', {
      ...(content.length > 0 ? { value: { content } } : {}),
      ...(truncated ? { truncated } : {}),
    })
  }
  let structured =
    result.structuredContent && typeof result.structuredContent === 'object'
      ? (result.structuredContent as Record<string, unknown>)
      : undefined
  if (structured && JSON.stringify(structured).length > MCP_STRUCTURED_MAX) {
    structured = undefined
    truncated = true
  }
  return toolOk<McpToolOutput>(
    {
      text,
      ...(content.length > 0 ? { content } : {}),
      ...(structured ? { structuredContent: structured } : {}),
    },
    truncated ? { truncated } : {},
  )
}

function schemaFor(definition: McpTool): Record<string, unknown> {
  const schema = definition.inputSchema as unknown
  assertPlainSchema(schema)
  if (schema.type !== 'object') throw new Error('The input schema must describe an object.')
  if (JSON.stringify(schema).length > MCP_SCHEMA_MAX) {
    throw new Error(`The input schema is larger than ${MCP_SCHEMA_MAX} characters.`)
  }
  return schema
}

function describe(serverName: string, definition: McpTool): string {
  const body = definition.description?.trim() || definition.title?.trim() || definition.name
  const text = `[MCP: ${serverName}] ${body}`
  return text.length > MCP_DESCRIPTION_MAX ? `${text.slice(0, MCP_DESCRIPTION_MAX - 1)}…` : text
}

export function buildMcpToolEntries(
  view: McpServerView,
  manager: Pick<McpConnectionManager, 'callTool'>,
): { entries: ExternalToolEntry[]; bindings: McpToolBinding[]; skipped: ExternalToolSkip[] } {
  const entries: ExternalToolEntry[] = []
  const bindings: McpToolBinding[] = []
  const skipped: ExternalToolSkip[] = []
  const disabled = new Set(view.config.disabledTools)
  const seen = new Map<string, string>()
  for (const definition of view.catalog.tools) {
    if (disabled.has(definition.name)) continue
    const exposedName = mcpToolName(view.config.name, definition.name)
    const clash = seen.get(exposedName)
    if (clash !== undefined) {
      skipped.push({
        name: definition.name,
        reason: `Its tool name "${exposedName}" collides with the tool "${clash}" on this server.`,
      })
      continue
    }
    let schema: Record<string, unknown>
    try {
      schema = schemaFor(definition)
    } catch (error) {
      skipped.push({
        name: definition.name,
        reason: `Its input schema was rejected: ${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }
    seen.set(exposedName, definition.name)
    const serverId = view.config.id
    const toolName = definition.name
    const description = describe(view.config.name, definition)
    bindings.push({ exposedName, serverId, toolName })
    entries.push({
      name: exposedName,
      kind: 'mcp',
      create: () =>
        tool({
          description,
          inputSchema: jsonSchema(schema as Parameters<typeof jsonSchema>[0]),
          execute: wrapToolExecute(async (input: unknown, options?: { abortSignal?: AbortSignal }) => {
            const args =
              typeof input === 'object' && input !== null && !Array.isArray(input)
                ? (input as Record<string, unknown>)
                : {}
            const result = await manager.callTool(serverId, toolName, args, options?.abortSignal)
            return mapCallToolResult(result)
          }),
        }),
    })
  }
  return { entries, bindings, skipped }
}

export function mcpSourceId(serverId: string): string {
  return `mcp:${serverId}`
}

export function bindMcpTools(manager: McpConnectionManager, registry: ToolRegistry): () => void {
  const seen = new Map<string, McpServerView>()
  const sync = () => {
    if (manager.isDisposed()) return
    const views = manager.views()
    const live = new Set(views.map((view) => view.config.id))
    for (const id of [...seen.keys()]) {
      if (live.has(id)) continue
      seen.delete(id)
      registry.clearExternalTools(mcpSourceId(id))
    }
    for (const view of views) {
      const previous = seen.get(view.config.id)
      if (
        previous &&
        previous.state === view.state &&
        previous.catalog === view.catalog &&
        previous.config === view.config
      ) {
        continue
      }
      seen.set(view.config.id, view)
      if (view.state !== 'ready') {
        registry.clearExternalTools(mcpSourceId(view.config.id))
        manager.setSkippedTools(view.config.id, [])
        continue
      }
      const built = buildMcpToolEntries(view, manager)
      const rejected = registry.setExternalTools(mcpSourceId(view.config.id), built.entries)
      const byExposed = new Map(built.bindings.map((binding) => [binding.exposedName, binding.toolName]))
      manager.setSkippedTools(view.config.id, [
        ...built.skipped,
        ...rejected.map((entry) => ({ name: byExposed.get(entry.name) ?? entry.name, reason: entry.reason })),
      ])
    }
  }
  sync()
  const unsubscribe = manager.store.subscribe(sync)
  return () => {
    unsubscribe()
    for (const id of seen.keys()) registry.clearExternalTools(mcpSourceId(id))
    seen.clear()
  }
}
