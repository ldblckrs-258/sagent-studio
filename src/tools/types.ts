import type { Tool } from 'ai'
import type { CodeRunner } from '../sandbox/types'

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
}

export interface WorkspaceApi {
  list(path: string): Promise<WorkspaceEntry[]>
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  makeDir(path: string): Promise<void>
  remove(path: string): Promise<void>
  stat(path: string): Promise<WorkspaceStat>
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

export interface ToolRuntimePorts {
  codeRunner?: CodeRunner
  workspace?: WorkspaceApi
  fetch?: typeof fetch
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
