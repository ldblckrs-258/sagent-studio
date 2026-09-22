import { useVaultStore } from '../vault/store'
import type { ProviderSelection } from './threads'

/**
 * Remembers the provider/model the user last chose so the next new conversation
 * opens on it. Writing the vault encrypts the whole settings blob, so a picker
 * change is debounced into one write; a lock that wins the race is swallowed
 * because the preference is a convenience, not durable work.
 */

export const LAST_MODEL_DEBOUNCE_MS = 500

let timer: ReturnType<typeof setTimeout> | null = null
let pending: ProviderSelection | null = null

/** Queues a selection; a newer call replaces the pending one. */
export function rememberLastModel(selection: ProviderSelection): void {
  pending = selection
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => {
    void flushLastModel()
  }, LAST_MODEL_DEBOUNCE_MS)
}

/** Writes any pending selection immediately. Exposed for tests and teardown. */
export async function flushLastModel(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  const selection = pending
  pending = null
  if (!selection) return
  try {
    await useVaultStore.getState().update({ lastModel: selection })
  } catch {
    // A locked vault or a concurrent failure must not surface as a chat error.
  }
}
