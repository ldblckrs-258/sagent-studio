import type { LanguageModel } from 'ai'
import type { TypeSafeClient } from '@typesafe-ai/sdk'

interface CacheEntry<T> {
  generation: number
  value: T
}

const llmCache = new Map<string, CacheEntry<LanguageModel>>()
const typesafeCache = new Map<string, CacheEntry<TypeSafeClient>>()

let currentGeneration = 0

export function getGeneration(): number {
  return currentGeneration
}

export function getOrCreateLLM(key: string, create: () => LanguageModel): LanguageModel {
  const hit = llmCache.get(key)
  if (hit && hit.generation === currentGeneration) return hit.value
  const value = create()
  llmCache.set(key, { generation: currentGeneration, value })
  return value
}

export function getOrCreateTypeSafe(key: string, create: () => TypeSafeClient): TypeSafeClient {
  const hit = typesafeCache.get(key)
  if (hit && hit.generation === currentGeneration) return hit.value
  const value = create()
  typesafeCache.set(key, { generation: currentGeneration, value })
  return value
}

export function invalidate(): void {
  llmCache.clear()
  typesafeCache.clear()
  currentGeneration += 1
}

export function setGeneration(generation: number): void {
  if (generation === currentGeneration) return
  currentGeneration = generation
  llmCache.clear()
  typesafeCache.clear()
}

export function cacheSizes(): { llm: number; typesafe: number } {
  return { llm: llmCache.size, typesafe: typesafeCache.size }
}
