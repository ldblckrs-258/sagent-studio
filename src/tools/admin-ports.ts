import type { SkillRegistry } from '../skills/registry'
import type { SkillManifest } from '../skills/schema'
import { VaultLockedError } from '../vault/errors'
import type { ToolRegistry, ToolStore } from './registry'
import { ToolNameConflictError, ToolNotFoundError } from './types'
import type {
  SkillAdminEntry,
  SkillAdminPort,
  SkillDraft,
  ToolAdminEntry,
  ToolAdminPort,
  ToolDefinition,
} from './types'

function toSkillEntry(registry: SkillRegistry, manifest: SkillManifest): SkillAdminEntry {
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    instructions: manifest.instructions,
    allowedTools: [...manifest.allowedTools],
    source: manifest.source,
    enabled: registry.isEnabled({ id: manifest.id, source: manifest.source }),
  }
}

/** Mirrors the Tools panel's one-line summary (`src/ui/panels/tools.tsx`). */
function summaryOf(definition: ToolDefinition): string {
  if (definition.kind === 'http') {
    return `${definition.request.method ?? 'GET'} ${definition.request.url}`
  }
  return definition.timeoutMs ? `sandbox · ${definition.timeoutMs} ms` : 'sandbox'
}

function toToolEntry(definition: ToolDefinition): ToolAdminEntry {
  return {
    name: definition.name,
    kind: definition.kind,
    description: definition.description,
    enabled: definition.enabled,
    summary: summaryOf(definition),
  }
}

/**
 * The vault enablement port swallows a `VaultLockedError` on write; a plain
 * `SkillEnablementPort` may surface it. Both mean "the policy write did not
 * persist", which the caller reconciles against the durable policy, so treat a
 * raw lock the same as the swallowed one.
 */
async function persistSkillPolicy(registry: SkillRegistry): Promise<void> {
  try {
    await registry.persistEnabled()
  } catch (error) {
    if (!(error instanceof VaultLockedError)) throw error
  }
}

export function createSkillAdminPort(registry: SkillRegistry): SkillAdminPort {
  const exists = (id: string): boolean => registry.list().some((manifest) => manifest.id === id)

  const entryOf = (manifest: SkillManifest): SkillAdminEntry => toSkillEntry(registry, manifest)

  return {
    list: () => registry.list().map(entryOf),
    get: (id, source) => {
      const manifest = registry.get({ id, source })
      return manifest ? entryOf(manifest) : undefined
    },
    exists,
    async create(draft: SkillDraft, options: { enabled?: boolean } = {}) {
      if (exists(draft.id)) throw new ToolNameConflictError(draft.id)
      const stored = await registry.importSkill({
        id: draft.id,
        name: draft.name,
        description: draft.description,
        instructions: draft.instructions,
        allowedTools: [...draft.allowedTools],
        source: 'vault',
      })
      if (!options.enabled) return entryOf(stored)
      const ref = { id: stored.id, source: 'vault' as const }
      registry.setEnabled(ref, true)
      await persistSkillPolicy(registry)
      return { ...entryOf(stored), enabled: await registry.reconcileEnabled(ref) }
    },
    async update(
      ref: { id: string; source: 'vault' | 'workspace' },
      patch: Partial<SkillDraft>,
      options: { enabled?: boolean } = {},
    ) {
      const current = registry.get(ref)
      if (!current) throw new ToolNotFoundError(ref.id)
      const merged: SkillManifest = {
        id: ref.id,
        source: ref.source,
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        instructions: patch.instructions ?? current.instructions,
        allowedTools: patch.allowedTools ? [...patch.allowedTools] : [...current.allowedTools],
      }
      await registry.updateSkill(merged)
      if (options.enabled === undefined) return { ...entryOf(merged), enabled: registry.isEnabled(ref) }
      registry.setEnabled(ref, options.enabled)
      await persistSkillPolicy(registry)
      return { ...entryOf(merged), enabled: await registry.reconcileEnabled(ref) }
    },
    async remove(ref) {
      await registry.removeSkill(ref)
    },
  }
}

export function createToolAdminPort(
  registry: ToolRegistry,
  store: ToolStore = registry.store(),
): ToolAdminPort {
  const find = (name: string): ToolDefinition | undefined =>
    registry.list().find((entry) => entry.name === name)

  return {
    list: () => registry.list().map(toToolEntry),
    get: find,
    hasTool: (name) => registry.hasTool(name),
    async create(definition: ToolDefinition) {
      if (registry.hasTool(definition.name)) throw new ToolNameConflictError(definition.name)
      await store.save(definition)
      try {
        registry.registerUserTool(definition)
      } catch (error) {
        await store.remove(definition.name).catch(() => undefined)
        throw error
      }
      return toToolEntry(definition)
    },
    async update(from: string, definition: ToolDefinition) {
      const current = find(from)
      if (!current) throw new ToolNotFoundError(from)

      if (definition.name !== from) {
        if (registry.hasTool(definition.name)) throw new ToolNameConflictError(definition.name)
        await store.save(definition)
        let removedOldRow = false
        try {
          await store.remove(from)
          removedOldRow = true
          registry.removeUserTool(from)
          registry.registerUserTool(definition)
        } catch (error) {
          if (removedOldRow) await store.save(current).catch(() => undefined)
          await store.remove(definition.name).catch(() => undefined)
          try {
            registry.removeUserTool(definition.name)
          } catch {
            // The entry was never registered; nothing to roll back.
          }
          try {
            if (!registry.list().some((entry) => entry.name === from)) {
              registry.registerUserTool(current)
            }
          } catch {
            // Best-effort restore; the surfaced error stays the actionable signal.
          }
          throw error
        }
        return toToolEntry(definition)
      }

      await store.save(definition)
      try {
        registry.replaceUserTool(definition)
      } catch (error) {
        await store.save(current).catch(() => undefined)
        throw error
      }
      return toToolEntry(definition)
    },
    async remove(name: string) {
      if (!find(name)) throw new ToolNotFoundError(name)
      await store.remove(name)
      registry.removeUserTool(name)
    },
  }
}

export interface AdminRegistries {
  skillRegistry: SkillRegistry
  toolRegistry: ToolRegistry
}

/**
 * Builds the two admin ports over the session's registries and serializes every
 * mutation through one promise chain, so a check-then-write sequence cannot
 * interleave two same-name calls from a single assistant turn.
 */
export function createAdminPorts(registries: AdminRegistries): {
  skillAdmin: SkillAdminPort
  toolAdmin: ToolAdminPort
} {
  const skill = createSkillAdminPort(registries.skillRegistry)
  const tool = createToolAdminPort(registries.toolRegistry)

  let chain: Promise<unknown> = Promise.resolve()
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  return {
    skillAdmin: {
      ...skill,
      create: (draft, options) => serialize(() => skill.create(draft, options)),
      update: (ref, patch, options) => serialize(() => skill.update(ref, patch, options)),
      remove: (ref) => serialize(() => skill.remove(ref)),
    },
    toolAdmin: {
      ...tool,
      create: (definition) => serialize(() => tool.create(definition)),
      update: (from, definition) => serialize(() => tool.update(from, definition)),
      remove: (name) => serialize(() => tool.remove(name)),
    },
  }
}
