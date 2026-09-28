import { jsonSchema, tool } from 'ai'
import type { Tool, ToolSet } from 'ai'
import { toolFail, wrapToolExecute } from './result'
import { toolStore } from './store'
import {
  ToolNameConflictError,
  ToolNotFoundError,
  ToolSchemaError,
  assertPlainSchema,
  isToolDefinition,
  TOOL_NAME_PATTERN,
  validateToolName,
} from './types'
import type {
  ExternalToolEntry,
  ExternalToolKind,
  ExternalToolSkip,
  ToolDefinition,
  ToolProvider,
  ToolRuntimePorts,
} from './types'
import { executeUserTool } from './user-tool'

export interface ToolStore {
  save(definition: ToolDefinition): Promise<void>
  remove(name: string): Promise<void>
  list(): Promise<ToolDefinition[]>
}

function asJsonSchema(schema: Record<string, unknown>): Parameters<typeof jsonSchema>[0] {
  return schema as Parameters<typeof jsonSchema>[0]
}

export class ToolRegistry {
  private readonly providers = new Map<string, ToolProvider>()
  private readonly userTools = new Map<string, ToolDefinition>()
  private readonly externalSources = new Map<string, Map<string, ExternalToolEntry>>()
  private readonly storeRef: ToolStore
  private readonly listeners = new Set<() => void>()
  private version = 0

  constructor(store: ToolStore = toolStore) {
    this.storeRef = store
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getVersion(): number {
    return this.version
  }

  private notify(): void {
    this.version += 1
    for (const listener of this.listeners) listener()
  }

  /** The store this registry persists to. Admin ports must never fall back to the global. */
  store(): ToolStore {
    return this.storeRef
  }

  async hydrate(): Promise<void> {
    // Skip-existing rather than throwing: a second unlock in the same module
    // session re-hydrates over the already-registered tools.
    for (const definition of await this.storeRef.list()) {
      if (this.providers.has(definition.name) || this.userTools.has(definition.name)) continue
      this.registerUserTool(definition)
    }
  }

  registerProvider(provider: ToolProvider): void {
    for (const name of provider.names) {
      validateToolName(name)
      if (this.hasTool(name)) {
        throw new ToolNameConflictError(name)
      }
      this.providers.set(name, provider)
    }
    this.notify()
  }

  registerUserTool(definition: ToolDefinition): void {
    if (!isToolDefinition(definition)) {
      throw new ToolSchemaError('The tool definition is malformed.')
    }
    validateToolName(definition.name)
    assertPlainSchema(definition.inputSchema)
    if (this.hasTool(definition.name)) {
      throw new ToolNameConflictError(definition.name)
    }
    this.userTools.set(definition.name, definition)
    this.notify()
  }

  replaceUserTool(definition: ToolDefinition): void {
    if (!isToolDefinition(definition)) {
      throw new ToolSchemaError('The tool definition is malformed.')
    }
    validateToolName(definition.name)
    assertPlainSchema(definition.inputSchema)
    if (this.providers.has(definition.name)) throw new ToolNameConflictError(definition.name)
    if (!this.userTools.has(definition.name)) throw new ToolNotFoundError(definition.name)
    this.userTools.set(definition.name, definition)
    this.notify()
  }

  setEnabled(name: string, enabled: boolean): void {
    const existing = this.userTools.get(name)
    if (!existing) throw new ToolNotFoundError(name)
    this.userTools.set(name, { ...existing, enabled })
    this.notify()
  }

  removeUserTool(name: string): void {
    if (!this.userTools.has(name)) throw new ToolNotFoundError(name)
    this.userTools.delete(name)
    this.notify()
  }

  /** True when a provider, a user tool, or an external source owns the name. */
  hasTool(name: string): boolean {
    return this.providers.has(name) || this.userTools.has(name) || this.externalOwner(name) !== undefined
  }

  setExternalTools(sourceId: string, entries: readonly ExternalToolEntry[]): ExternalToolSkip[] {
    const accepted = new Map<string, ExternalToolEntry>()
    const skipped: ExternalToolSkip[] = []
    for (const entry of entries) {
      if (!TOOL_NAME_PATTERN.test(entry.name)) {
        skipped.push({ name: entry.name, reason: 'The derived tool name is not a valid tool name.' })
        continue
      }
      const owner = this.externalOwner(entry.name)
      if (
        this.providers.has(entry.name) ||
        this.userTools.has(entry.name) ||
        (owner !== undefined && owner !== sourceId)
      ) {
        skipped.push({ name: entry.name, reason: `A tool named "${entry.name}" already exists.` })
        continue
      }
      if (accepted.has(entry.name)) {
        skipped.push({ name: entry.name, reason: `Another tool from this source is also named "${entry.name}".` })
        continue
      }
      accepted.set(entry.name, entry)
    }
    this.externalSources.set(sourceId, accepted)
    this.notify()
    return skipped
  }

  clearExternalTools(sourceId: string): void {
    if (!this.externalSources.delete(sourceId)) return
    this.notify()
  }

  listExternal(): Array<{ name: string; kind: ExternalToolKind }> {
    const entries: Array<{ name: string; kind: ExternalToolKind }> = []
    for (const source of this.externalSources.values()) {
      for (const entry of source.values()) entries.push({ name: entry.name, kind: entry.kind })
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name))
  }

  private externalOwner(name: string): string | undefined {
    for (const [sourceId, source] of this.externalSources) {
      if (source.has(name)) return sourceId
    }
    return undefined
  }

  private externalEntry(name: string): ExternalToolEntry | undefined {
    for (const source of this.externalSources.values()) {
      const entry = source.get(name)
      if (entry) return entry
    }
    return undefined
  }

  list(): ToolDefinition[] {
    return [...this.userTools.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  toolKind(name: string): ToolDefinition['kind'] | ExternalToolKind | undefined {
    return this.userTools.get(name)?.kind ?? this.externalEntry(name)?.kind
  }

  availableNames(ports: ToolRuntimePorts): string[] {
    const names = new Set<string>()
    for (const [name, provider] of this.providers) {
      if (provider.isAvailable(ports)) names.add(name)
    }
    for (const definition of this.userTools.values()) {
      if (definition.enabled) names.add(definition.name)
    }
    for (const source of this.externalSources.values()) {
      for (const name of source.keys()) names.add(name)
    }
    return [...names].sort()
  }

  buildToolSet(requestedNames: readonly string[] | undefined, ports: ToolRuntimePorts): ToolSet {
    const pool = this.availableNames(ports)
    const requested = requestedNames === undefined ? null : new Set(requestedNames)
    const selected = (requested === null ? pool : pool.filter((name) => requested.has(name))).slice()
    selected.sort()

    const toolSet: ToolSet = {}
    for (const name of selected) {
      const provider = this.providers.get(name)
      if (provider) {
        toolSet[name] = provider.create(name, ports)
        continue
      }
      const definition = this.userTools.get(name)
      if (definition) {
        toolSet[name] = this.createUserTool(definition, ports)
        continue
      }
      const external = this.externalEntry(name)
      if (external) toolSet[name] = external.create(ports)
    }
    return toolSet
  }

  private currentUserTool(definition: ToolDefinition): ToolDefinition | undefined {
    const live = this.userTools.get(definition.name)
    if (!live || !live.enabled || live.kind !== definition.kind) return undefined
    return live
  }

  private createUserTool(definition: ToolDefinition, ports: ToolRuntimePorts): Tool {
    const stale = () =>
      toolFail(
        'not_found',
        `The tool "${definition.name}" was renamed, disabled, or removed during this turn.`,
        { hint: 'Call list_user_tools to see the current definitions.' },
      )

    return tool({
      description: definition.description,
      inputSchema: jsonSchema(asJsonSchema(definition.inputSchema)),
      execute: wrapToolExecute(async (input: unknown) => {
        const live = this.currentUserTool(definition)
        if (!live) return stale()
        return executeUserTool(live, input, ports)
      }),
    })
  }
}
