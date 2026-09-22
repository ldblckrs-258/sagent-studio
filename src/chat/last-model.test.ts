import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVaultStore } from '../vault/store'
import { LAST_MODEL_DEBOUNCE_MS, flushLastModel, rememberLastModel } from './last-model'

describe('rememberLastModel', () => {
  const update = vi.fn(async () => {})

  beforeEach(() => {
    vi.useFakeTimers()
    update.mockClear()
    vi.spyOn(useVaultStore, 'getState').mockReturnValue({ update } as never)
  })

  afterEach(async () => {
    await flushLastModel()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('debounces several picks into one write of the newest selection', async () => {
    rememberLastModel({ providerId: 'p1', modelId: 'm1' })
    rememberLastModel({ providerId: 'p2', modelId: 'm2' })
    await vi.advanceTimersByTimeAsync(LAST_MODEL_DEBOUNCE_MS)
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ lastModel: { providerId: 'p2', modelId: 'm2' } })
  })

  it('does not write before the debounce elapses', async () => {
    rememberLastModel({ providerId: 'p1' })
    await vi.advanceTimersByTimeAsync(LAST_MODEL_DEBOUNCE_MS - 1)
    expect(update).not.toHaveBeenCalled()
  })

  it('swallows a rejected write', async () => {
    update.mockRejectedValueOnce(new Error('locked'))
    rememberLastModel({ providerId: 'p1' })
    await vi.advanceTimersByTimeAsync(LAST_MODEL_DEBOUNCE_MS)
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('flush writes immediately and cancels the pending timer', async () => {
    rememberLastModel({ providerId: 'p1' })
    await flushLastModel()
    expect(update).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(LAST_MODEL_DEBOUNCE_MS)
    expect(update).toHaveBeenCalledTimes(1)
  })
})
