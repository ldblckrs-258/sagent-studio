import { db } from '../vault/db'
import { decryptRecord, encryptRecord } from '../vault/records'
import { vaultWriteQueue } from '../vault/write-queue'
import { ToolSchemaError, assertPlainSchema, isToolDefinition, validateToolName } from './types'
import type { HttpToolDefinition, SandboxJsToolDefinition, ToolDefinition } from './types'

export const TOOL_ENVELOPE_VERSION = 1

export function assertHttpDefinition(definition: HttpToolDefinition): void {
  const request = definition.request
  if (typeof request?.url !== 'string' || request.url.length === 0) {
    throw new ToolSchemaError(`The http tool "${definition.name}" needs a request URL.`)
  }
  if (!Array.isArray(request.allowedOrigins)) {
    throw new ToolSchemaError(`The http tool "${definition.name}" needs an allowedOrigins list.`)
  }
  for (const origin of request.allowedOrigins) {
    if (typeof origin !== 'string') {
      throw new ToolSchemaError(`The http tool "${definition.name}" has a non-string origin.`)
    }
  }
  if (request.method !== undefined && typeof request.method !== 'string') {
    throw new ToolSchemaError(`The http tool "${definition.name}" has a non-string method.`)
  }
  if (request.body !== undefined && typeof request.body !== 'string') {
    throw new ToolSchemaError(`The http tool "${definition.name}" has a non-string body.`)
  }
  if (
    request.timeoutMs !== undefined &&
    (typeof request.timeoutMs !== 'number' ||
      !Number.isFinite(request.timeoutMs) ||
      request.timeoutMs <= 0)
  ) {
    throw new ToolSchemaError(`The http tool "${definition.name}" has an invalid timeout.`)
  }
  if (request.headers !== undefined) {
    if (typeof request.headers !== 'object' || request.headers === null || Array.isArray(request.headers)) {
      throw new ToolSchemaError(`The http tool "${definition.name}" has invalid headers.`)
    }
    for (const value of Object.values(request.headers)) {
      if (typeof value !== 'string') {
        throw new ToolSchemaError(`The http tool "${definition.name}" has a non-string header value.`)
      }
    }
  }
}

function assertDefinition(definition: unknown): ToolDefinition {
  if (!isToolDefinition(definition)) {
    throw new ToolSchemaError('The tool definition is malformed.')
  }
  validateToolName(definition.name)
  assertPlainSchema(definition.inputSchema)
  if (definition.kind === 'sandbox-js') {
    if (typeof (definition as SandboxJsToolDefinition).source !== 'string') {
      throw new ToolSchemaError(`The sandbox-js tool "${definition.name}" needs source text.`)
    }
    return definition
  }
  const http = definition as HttpToolDefinition
  assertHttpDefinition(http)
  return http
}

function parseEnvelope(raw: string): ToolDefinition {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new ToolSchemaError('The decrypted tool was not valid JSON.', { cause })
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ToolSchemaError('The tool envelope was not an object.')
  }
  const version = (parsed as { version?: unknown }).version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new ToolSchemaError('The tool envelope version is invalid.')
  }
  if (version > TOOL_ENVELOPE_VERSION) {
    throw new ToolSchemaError(`Tool envelope version ${version} is newer than this app supports.`)
  }
  return assertDefinition((parsed as { tool?: unknown }).tool)
}

export async function saveTool(definition: ToolDefinition): Promise<void> {
  const validated = assertDefinition(definition)
  await vaultWriteQueue.enqueue(async () => {
    const envelope = JSON.stringify({ version: TOOL_ENVELOPE_VERSION, tool: validated })
    const blob = await encryptRecord(envelope, `tool:${validated.name}`)
    await db.tools.put({ id: validated.name, blob, updatedAt: Date.now() })
  })
}

export async function loadTool(name: string): Promise<ToolDefinition | null> {
  const row = await db.tools.get(name)
  if (!row) return null
  return parseEnvelope(await decryptRecord(row.blob, `tool:${name}`))
}

export async function listTools(): Promise<ToolDefinition[]> {
  const rows = await db.tools.toArray()
  const tools = await Promise.all(
    rows.map(async (row) => parseEnvelope(await decryptRecord(row.blob, `tool:${row.id}`))),
  )
  return tools.sort((a, b) => a.name.localeCompare(b.name))
}

export async function deleteTool(name: string): Promise<void> {
  await vaultWriteQueue.enqueue(async () => {
    await db.tools.delete(name)
  })
}

export const toolStore = {
  save: saveTool,
  remove: deleteTool,
  list: listTools,
}
