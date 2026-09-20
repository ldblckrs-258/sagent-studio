import { describe, expect, it } from 'vitest'
import { DEFAULT_CHAT_MODE, isChatMode } from './types'

describe('ChatMode', () => {
  it('accepts exactly the three modes', () => {
    expect(isChatMode('read_only')).toBe(true)
    expect(isChatMode('editing')).toBe(true)
    expect(isChatMode('god')).toBe(true)
    expect(isChatMode('admin')).toBe(false)
    expect(isChatMode(undefined)).toBe(false)
    expect(isChatMode(1)).toBe(false)
  })

  it('defaults to editing', () => {
    expect(DEFAULT_CHAT_MODE).toBe('editing')
  })
})
