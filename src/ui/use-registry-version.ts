import { useCallback, useSyncExternalStore } from 'react'

export interface RegistryObserver {
  subscribe(listener: () => void): () => void
  getVersion(): number
}

/**
 * Subscribes a component to a registry's mutation counter. `getSnapshot`
 * returns a primitive, and both callbacks are memoized on the registry
 * identity, so a session swap re-subscribes without a render loop.
 */
export function useRegistryVersion(registry: RegistryObserver): number {
  const subscribe = useCallback(
    (listener: () => void) => registry.subscribe(listener),
    [registry],
  )
  const getSnapshot = useCallback(() => registry.getVersion(), [registry])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
