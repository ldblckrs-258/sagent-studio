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
  validateToolName,
} from './types'
import type { ToolDefinition, ToolProvider, ToolRuntimePorts } from './types'
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
      if (this.providers.has(name) || this.userTools.has(name)) {
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
    if (this.providers.has(definition.name) || this.userTools.has(definition.name)) {
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

  /** True when a provider or a user tool owns the name. */
  hasTool(name: string): boolean {
    return this.providers.has(name) || this.userTools.has(name)
  }

  list(): ToolDefinition[] {
    return [...this.userTools.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  userToolKind(name: string): ToolDefinition['kind'] | undefined {
    return this.userTools.get(name)?.kind
  }

  availableNames(ports: ToolRuntimePorts): string[] {
    const names = new Set<string>()
    for (const [name, provider] of this.providers) {
      if (provider.isAvailable(ports)) names.add(name)
    }
    for (const definition of this.userTools.values()) {
      if (definition.enabled) names.add(definition.name)
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
      if (definition) toolSet[name] = this.createUserTool(definition, ports)
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
