import { beforeEach, describe, expect, it } from 'vitest'
import { useChatStore } from './store'

describe('useChatStore run accounting', () => {
  beforeEach(() => {
    useChatStore.getState().clear()
  })

  it('derives streaming status from the active-run count', () => {
    expect(useChatStore.getState().activeRuns).toBe(0)
    expect(useChatStore.getState().status).toBe('idle')

    useChatStore.getState().beginRun('t1')
    expect(useChatStore.getState().activeRuns).toBe(1)
    expect(useChatStore.getState().runningThreads.t1).toBe(1)
    expect(useChatStore.getState().status).toBe('streaming')

    useChatStore.getState().endRun('t1')
    expect(useChatStore.getState().activeRuns).toBe(0)
    expect(useChatStore.getState().runningThreads.t1).toBeUndefined()
    expect(useChatStore.getState().status).toBe('idle')
  })

  it('tracks runs per thread and keeps streaming while another thread runs', () => {
    useChatStore.getState().beginRun('t1')
    useChatStore.getState().beginRun('t2')
    expect(useChatStore.getState().activeRuns).toBe(2)

    useChatStore.getState().endRun('t1')
    expect(useChatStore.getState().activeRuns).toBe(1)
    expect(useChatStore.getState().runningThreads.t1).toBeUndefined()
    expect(useChatStore.getState().runningThreads.t2).toBe(1)
    expect(useChatStore.getState().status).toBe('streaming')

    useChatStore.getState().endRun('t2')
    expect(useChatStore.getState().status).toBe('idle')
  })

  it('never counts below zero', () => {
    useChatStore.getState().endRun('missing')
    expect(useChatStore.getState().activeRuns).toBe(0)
    expect(useChatStore.getState().runningThreads.missing).toBeUndefined()
    expect(useChatStore.getState().status).toBe('idle')
  })

  it('resets the run count on clear', () => {
    useChatStore.getState().beginRun('t1')
    useChatStore.getState().clear()
    expect(useChatStore.getState().activeRuns).toBe(0)
    expect(useChatStore.getState().runningThreads).toEqual({})
    expect(useChatStore.getState().status).toBe('idle')
  })
})
