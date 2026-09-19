import { beforeEach, describe, expect, it } from 'vitest'
import { VaultLockedError } from '../vault/errors'
import { vaultInternals, useVaultStore } from '../vault/store'
import { createVaultSkillEnablement } from './enablement'

describe('vault skill enablement', () => {
  beforeEach(async () => {
    await vaultInternals.reset()
    await useVaultStore.getState().setup('enablement-password')
  })

  it('returns null before any policy is persisted', async () => {
    const port = createVaultSkillEnablement()
    expect(await port.load()).toBeNull()
  })

  it('round-trips a persisted policy', async () => {
    const port = createVaultSkillEnablement()
    await port.save([
      { id: 's1', source: 'vault' },
      { id: 'w1', source: 'workspace' },
    ])
    expect(await port.load()).toEqual([
      { id: 's1', source: 'vault' },
      { id: 'w1', source: 'workspace' },
    ])
  })

  it('fails closed while locked: load rejects, save is benign', async () => {
    const port = createVaultSkillEnablement()
    await useVaultStore.getState().lock()
    await expect(port.load()).rejects.toBeInstanceOf(VaultLockedError)
    await expect(port.save([{ id: 's1', source: 'vault' }])).resolves.toBeUndefined()
  })
})
