import { jsonSchema, tool } from 'ai'
import type { Tool, ToolSet } from 'ai'
import { executeHttpTool } from './http'
import { toolStore } from './store'
import {
  ToolNameConflictError,
  ToolNotFoundError,
  ToolRuntimeUnavailableError,
  ToolSchemaError,
  assertPlainSchema,
  isToolDefinition,
  validateToolName,
} from './types'
import type { ToolDefinition, ToolProvider, ToolRuntimePorts } from './types'

export interface ToolStore {
  save(definition: ToolDefinition): Promise<void>
  remove(name: string): Promise<void>
  list(): Promise<ToolDefinition[]>
}

function bindInput(source: string, input: unknown): string {
  return `const input = ${JSON.stringify(input ?? null)};\n${source}`
}

function asJsonSchema(schema: Record<string, unknown>): Parameters<typeof jsonSchema>[0] {
  return schema as Parameters<typeof jsonSchema>[0]
}

export class ToolRegistry {
  private readonly providers = new Map<string, ToolProvider>()
  private readonly userTools = new Map<string, ToolDefinition>()
  private readonly store: ToolStore

  constructor(store: ToolStore = toolStore) {
    this.store = store
  }

  async hydrate(): Promise<void> {
    // Skip-existing rather than throwing: a second unlock in the same module
    // session re-hydrates over the already-registered tools.
    for (const definition of await this.store.list()) {
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
  }

  setEnabled(name: string, enabled: boolean): void {
    const existing = this.userTools.get(name)
    if (!existing) throw new ToolNotFoundError(name)
    this.userTools.set(name, { ...existing, enabled })
  }

  removeUserTool(name: string): void {
    if (!this.userTools.has(name)) throw new ToolNotFoundError(name)
    this.userTools.delete(name)
  }

  list(): ToolDefinition[] {
    return [...this.userTools.values()].sort((a, b) => a.name.localeCompare(b.name))
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

  private createUserTool(definition: ToolDefinition, ports: ToolRuntimePorts): Tool {
    const shared = {
      description: definition.description,
      inputSchema: jsonSchema(asJsonSchema(definition.inputSchema)),
    }

    if (definition.kind === 'sandbox-js') {
      return tool({
        ...shared,
        execute: async (input: unknown) => {
          if (!ports.codeRunner) throw new ToolRuntimeUnavailableError(definition.name)
          return ports.codeRunner.run(bindInput(definition.source, input), {
            timeoutMs: definition.timeoutMs,
          })
        },
      })
    }

    return tool({
      ...shared,
      execute: async (input: unknown) => executeHttpTool(definition.request, input, ports.fetch),
    })
  }
}
