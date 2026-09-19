import { beforeEach, describe, expect, it } from 'vitest'
import { abortersCount, useChatStore } from '../chat/store'
import type { CodeRunner } from '../sandbox/types'
import type { CodeToolRunners } from '../tools/builtin/code'
import { createSession } from './session'

function noopRunner(): CodeRunner {
  return { run: async () => ({ stdout: '', stderr: '', result: null }) }
}

describe('createSession', () => {
  beforeEach(() => {
    useChatStore.getState().clear()
  })

  it('memoizes one engine per thread and disposes it', () => {
    const before = abortersCount()
    const session = createSession()
    const first = session.engineFor('t1')

    expect(session.engineFor('t1')).toBe(first)
    expect(session.engineFor('t2')).not.toBe(first)
    expect(abortersCount()).toBe(before + 2)

    session.disposeThread('t1')
    expect(abortersCount()).toBe(before + 1)

    session.dispose()
    expect(abortersCount()).toBe(before)
  })

  it('registers the builtin providers and hydrates idempotently', async () => {
    const session = createSession()
    expect(session.toolRegistry.availableNames({})).toEqual(['run_js', 'run_python'])

    await session.toolRegistry.hydrate()
    await session.toolRegistry.hydrate()
    expect(session.toolRegistry.availableNames({})).toEqual(['run_js', 'run_python'])

    session.dispose()
  })

  it('drops the code tools from the pool when the runner source is disabled', () => {
    let enabled = true
    const runners: CodeToolRunners = { js: noopRunner(), python: noopRunner() }
    const session = createSession({
      runnerSource: { getRunners: () => runners, isEnabled: () => enabled },
    })

    expect(session.toolRegistry.availableNames({})).toEqual(['run_js', 'run_python'])
    enabled = false
    expect(session.toolRegistry.availableNames({})).toEqual([])

    session.dispose()
  })
})
