import type { Tool } from 'ai'
import type { CodeRunner } from '../sandbox/types'
import type { WorkspaceJournal } from '../workspace/journal'
import type { ChatMode, PlanItem } from '../chat/types'
import type { ApprovalDecision } from '../vault/settings'

export type JsonSchemaObject = Record<string, unknown>

export interface WorkspaceEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
  size?: number
}

export interface WorkspaceStat {
  path: string
  kind: 'file' | 'directory'
  size: number
  lastModified?: number
}

export interface WorkspaceListOptions {
  recursive?: boolean
  glob?: string
  maxEntries?: number
}

export interface WorkspaceTransferResult {
  from: string
  to: string
  kind: 'file' | 'directory'
  size: number
}

export interface WorkspaceSearchOptions {
  pattern: string
  ignoreCase?: boolean
  path?: string
  maxResults?: number
  maxFilesScanned?: number
  maxDepth?: number
  excludedDirs?: string[]
}

export interface WorkspaceSearchHit {
  path: string
  line: number
  text: string
}

export interface WorkspaceSearchSkip {
  path: string
  reason: string
}

export interface WorkspaceSearchResult {
  hits: WorkspaceSearchHit[]
  truncated: boolean
  filesScanned: number
  filesSkipped: number
  /** Per-file reasons for `filesSkipped`, so empty hits never reads as "no match". */
  skipped?: WorkspaceSearchSkip[]
}

export interface WorkspaceFindLinesOptions {
  pattern: string
  ignoreCase?: boolean
  maxResults?: number
}

export interface WorkspaceFindLinesResult {
  path: string
  hits: WorkspaceSearchHit[]
  truncated: boolean
}

export interface WorkspaceApi {
  list(path: string, options?: WorkspaceListOptions): Promise<WorkspaceEntry[]>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  makeDir(path: string): Promise<void>
  remove(path: string): Promise<void>
  stat(path: string): Promise<WorkspaceStat>
  move(from: string, to: string): Promise<WorkspaceTransferResult>
  copy(from: string, to: string): Promise<WorkspaceTransferResult>
  search(options: WorkspaceSearchOptions): Promise<WorkspaceSearchResult>
  /**
   * Scans one file for matching lines without loading the whole file, so a
   * large artifact stays searchable past `readFile`'s size cap. Optional so
   * existing workspace mocks stay valid.
   */
  findLines?(path: string, options: WorkspaceFindLinesOptions): Promise<WorkspaceFindLinesResult>
}

export interface SandboxJsToolDefinition {
  kind: 'sandbox-js'
  name: string
  description: string
  inputSchema: JsonSchemaObject
  source: string
  timeoutMs?: number
  enabled: boolean
}

export interface HttpRequestTemplate {
  method?: string
  url: string
  headers?: Record<string, string>
  body?: string
  allowedOrigins: string[]
  timeoutMs?: number
}

export interface HttpToolDefinition {
  kind: 'http'
  name: string
  description: string
  inputSchema: JsonSchemaObject
  request: HttpRequestTemplate
  enabled: boolean
}

export type ToolDefinition = SandboxJsToolDefinition | HttpToolDefinition

export interface SandboxControlPort {
  reset(language?: 'js' | 'python'): void
  status(): { js: boolean; python: boolean }
}

export interface ThreadModePort {
  setMode(mode: ChatMode): Promise<void>
}

export interface SkillLoadEntry {
  id: string
  name: string
  description: string
  source: 'vault' | 'workspace'
}

export interface SkillLoadResult extends SkillLoadEntry {
  instructions: string
}

export interface SkillLoadPort {
  list(): ReadonlyArray<SkillLoadEntry>
  load(id: string, source?: 'vault' | 'workspace'): SkillLoadResult | null
}

export interface ThreadPlanPort {
  get(): ReadonlyArray<PlanItem>
  set(items: readonly PlanItem[]): Promise<void>
}

/** Lets a tool hand a workspace file to the File panel without importing a UI store. */
export interface PreviewPort {
  open(path: string): void
}

export interface SkillDraft {
  id: string
  name: string
  description: string
  instructions: string
  allowedTools: string[]
}

export interface SkillAdminEntry extends SkillDraft {
  source: 'vault' | 'workspace'
  enabled: boolean
}

export interface SkillAdminPort {
  list(): SkillAdminEntry[]
  get(id: string, source: 'vault' | 'workspace'): SkillAdminEntry | undefined
  /** True when the id exists under any source. */
  exists(id: string): boolean
  create(draft: SkillDraft, options?: { enabled?: boolean }): Promise<SkillAdminEntry>
  update(
    ref: { id: string; source: 'vault' | 'workspace' },
    patch: Partial<SkillDraft>,
    options?: { enabled?: boolean },
  ): Promise<SkillAdminEntry>
  remove(ref: { id: string; source: 'vault' | 'workspace' }): Promise<void>
}

export interface ToolAdminEntry {
  name: string
  kind: ToolDefinition['kind']
  description: string
  enabled: boolean
  summary: string
}

export interface ToolAdminPort {
  list(): ToolAdminEntry[]
  get(name: string): ToolDefinition | undefined
  /** True when a provider or a user tool owns the name. */
  hasTool(name: string): boolean
  create(definition: ToolDefinition): Promise<ToolAdminEntry>
  /** Replaces the tool named `from`; renames when `definition.name !== from`. */
  update(from: string, definition: ToolDefinition): Promise<ToolAdminEntry>
  remove(name: string): Promise<void>
}

export interface ApprovalPolicyPort {
  decision(toolName: string): ApprovalDecision
}

export interface ToolRuntimePorts {
  codeRunner?: CodeRunner
  workspace?: WorkspaceApi
  /** The conversation's write journal, used to record mutations and expose checkpoint tools. */
  journal?: WorkspaceJournal
  fetch?: typeof fetch
  sandbox?: SandboxControlPort
  mode?: ThreadModePort
  skills?: SkillLoadPort
  plan?: ThreadPlanPort
  preview?: PreviewPort
  skillAdmin?: SkillAdminPort
  toolAdmin?: ToolAdminPort
  approvals?: ApprovalPolicyPort
}

export interface ToolProvider {
  names: readonly string[]
  isAvailable(ports: ToolRuntimePorts): boolean
  create(name: string, ports: ToolRuntimePorts): Tool
}

export class ToolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ToolError'
  }
}

export class ToolNameConflictError extends ToolError {
  constructor(name: string, options?: ErrorOptions) {
    super(`A tool named "${name}" is already registered.`, options)
    this.name = 'ToolNameConflictError'
  }
}

export class ToolRuntimeUnavailableError extends ToolError {
  constructor(name: string, options?: ErrorOptions) {
    super(`The runtime required by tool "${name}" is not available.`, options)
    this.name = 'ToolRuntimeUnavailableError'
  }
}

export class ToolSchemaError extends ToolError {
  constructor(message = 'The tool schema is invalid.', options?: ErrorOptions) {
    super(message, options)
    this.name = 'ToolSchemaError'
  }
}

export class ToolNotFoundError extends ToolError {
  constructor(name: string, options?: ErrorOptions) {
    super(`No enabled tool is named "${name}".`, options)
    this.name = 'ToolNotFoundError'
  }
}

export class HttpToolError extends ToolError {
  constructor(message = 'The HTTP tool request failed.', options?: ErrorOptions) {
    super(message, options)
    this.name = 'HttpToolError'
  }
}

export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_]{1,64}$/

export function validateToolName(name: string): void {
  if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) {
    throw new ToolSchemaError(
      `Tool names must match ${TOOL_NAME_PATTERN.source} (received "${String(name)}").`,
    )
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function assertPlainSchema(schema: unknown): asserts schema is JsonSchemaObject {
  const visit = (value: unknown, depth: number): void => {
    if (depth > 32) throw new ToolSchemaError('The schema is nested too deeply.')
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    if (typeof value !== 'object' || value === null) return
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      throw new ToolSchemaError('The schema must contain only plain objects.')
    }
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new ToolSchemaError(`The schema contains an unsafe key "${key}".`)
      }
      visit(nested, depth + 1)
    }
  }
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new ToolSchemaError('A tool schema must be a plain object.')
  }
  visit(schema, 0)
}

export function isToolDefinition(value: unknown): value is ToolDefinition {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (candidate.kind !== 'sandbox-js' && candidate.kind !== 'http') return false
  if (typeof candidate.name !== 'string') return false
  if (typeof candidate.description !== 'string') return false
  if (typeof candidate.enabled !== 'boolean') return false
  return typeof candidate.inputSchema === 'object' && candidate.inputSchema !== null
}
