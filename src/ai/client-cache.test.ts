import { beforeEach, describe, expect, it } from 'vitest'
import {
  cacheSizes,
  getGeneration,
  getOrCreateLLM,
  getOrCreateTypeSafe,
  invalidate,
  setGeneration,
} from './client-cache'
import type { LanguageModel } from 'ai'
import type { TypeSafeClient } from '@typesafe-ai/sdk'

function fakeModel(id: number): LanguageModel {
  return { specificationVersion: 'v4', modelId: `m${id}` } as unknown as LanguageModel
}

function fakeClient(id: number): TypeSafeClient {
  return { defaultModel: `c${id}` } as unknown as TypeSafeClient
}

describe('client-cache', () => {
  beforeEach(() => {
    invalidate()
  })

  it('returns the same instance for a repeated key', () => {
    const first = getOrCreateLLM('k', () => fakeModel(1))
    const second = getOrCreateLLM('k', () => fakeModel(2))
    expect(second).toBe(first)
  })

  it('creates a distinct instance for a different key', () => {
    const a = getOrCreateLLM('a', () => fakeModel(1))
    const b = getOrCreateLLM('b', () => fakeModel(2))
    expect(a).not.toBe(b)
  })

  it('caches LanguageModel and TypeSafeClient separately', () => {
    getOrCreateLLM('shared', () => fakeModel(1))
    getOrCreateTypeSafe('shared', () => fakeClient(1))
    expect(cacheSizes()).toEqual({ llm: 1, typesafe: 1 })
  })

  it('empties both caches on invalidate()', () => {
    getOrCreateLLM('a', () => fakeModel(1))
    getOrCreateTypeSafe('b', () => fakeClient(1))
    invalidate()
    expect(cacheSizes()).toEqual({ llm: 0, typesafe: 0 })
  })

  it('creates a new instance after invalidate(), proving lock discards clients', () => {
    const before = getOrCreateTypeSafe('k', () => fakeClient(1))
    invalidate()
    const after = getOrCreateTypeSafe('k', () => fakeClient(2))
    expect(after).not.toBe(before)
  })

  it('keeps the cache when setGeneration receives the current value', () => {
    getOrCreateLLM('a', () => fakeModel(1))
    setGeneration(getGeneration())
    expect(cacheSizes().llm).toBe(1)
  })

  it('clears the cache when the generation advances', () => {
    getOrCreateLLM('a', () => fakeModel(1))
    setGeneration(getGeneration() + 1)
    expect(cacheSizes().llm).toBe(0)
  })
})
