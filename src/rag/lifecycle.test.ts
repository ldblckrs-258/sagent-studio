import { beforeEach, describe, expect, it } from 'vitest'
import { deriveKey, randomBytes } from '../vault/crypto'
import * as keyring from '../vault/keyring'
import { useVaultStore, vaultInternals } from '../vault/store'
import { clear, entryCount, isHydrated } from './index-cache'
import { startRagIndex } from './lifecycle'
import { putDocumentAndChunks } from './store'
import type { DocumentMeta, StoredChunk } from './types'

const KDF = { algorithm: 'PBKDF2-SHA256' as const, iterations: 1000, salt: randomBytes(16) }

async function installVault(): Promise<void> {
  await vaultInternals.reset()
  keyring.install(await deriveKey('rag-lifecycle-password', KDF))
  useVaultStore.setState({ status: 'unlocked', unlockGeneration: keyring.getGeneration() })
}

async function seed(docId: string): Promise<void> {
  const chunk: StoredChunk = {
    id: `${docId}-c0`,
    docId,
    ordinal: 0,
    dims: 2,
    text: 'chunk',
    vector: Float32Array.from([1, 0]),
  }
  const meta: DocumentMeta = {
    id: docId,
    title: docId,
    kind: 'text',
    sourceName: `${docId}.txt`,
    byteSize: 1,
    chunkCount: 1,
    chunkSize: 400,
    overlap: 60,
    embedProviderId: 'p1',
    embedModel: 'embed',
    dims: 2,
    createdAt: 1,
    updatedAt: 1,
  }
  await putDocumentAndChunks(meta, [chunk])
}

describe('startRagIndex', () => {
  beforeEach(async () => {
    await installVault()
    clear()
  })

  it('hydrates the cache and stop() clears it; a second stop is a no-op', async () => {
    await seed('d1')
    const stop = await startRagIndex()
    expect(isHydrated()).toBe(true)
    expect(entryCount()).toBe(1)

    stop()
    expect(isHydrated()).toBe(false)
    expect(entryCount()).toBe(0)
    expect(() => stop()).not.toThrow()
  })

  it('does not hydrate when the caller signal is already aborted', async () => {
    await seed('d1')
    const controller = new AbortController()
    controller.abort()
    const stop = await startRagIndex({ signal: controller.signal })
    expect(isHydrated()).toBe(false)
    expect(() => stop()).not.toThrow()
  })

  it('reports hydration progress', async () => {
    await seed('d1')
    const progress: number[] = []
    const stop = await startRagIndex({ onProgress: ({ done }) => progress.push(done) })
    expect(progress.at(-1)).toBe(1)
    stop()
  })
})
