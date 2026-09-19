import type { SkillRef } from '../chat/types'
import { VaultLockedError } from '../vault/errors'
import { useVaultStore } from '../vault/store'

export interface SkillEnablementPort {
  /** Returns `null` when no policy has ever been persisted (legacy enable-all). */
  load(): Promise<SkillRef[] | null>
  save(enabled: readonly SkillRef[]): Promise<void>
}

function toPersisted(refs: readonly SkillRef[]): Array<{ id: string; source: 'vault' | 'workspace' }> {
  return refs.map((ref) => ({ id: ref.id, source: ref.source }))
}

/** A skill enablement policy backed by the encrypted vault settings. */
export function createVaultSkillEnablement(): SkillEnablementPort {
  return {
    async load() {
      const settings = useVaultStore.getState().settings
      // Locked is not "no policy": never let it fall through to enable-all.
      if (!settings) throw new VaultLockedError()
      const slice = settings.skills?.enabled
      return slice ? slice.map((ref) => ({ id: ref.id, source: ref.source })) : null
    },
    async save(enabled) {
      try {
        await useVaultStore.getState().update({ skills: { enabled: toPersisted(enabled) } })
      } catch (error) {
        // A lock race is benign, matching the existing debounced provider writes.
        if (error instanceof VaultLockedError) return
        throw error
      }
    },
  }
}
