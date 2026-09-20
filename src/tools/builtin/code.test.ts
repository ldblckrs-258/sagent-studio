import { describe, expect, it } from 'vitest'
import type { ToolSet } from 'ai'
import { SandboxTimeoutError } from '../../sandbox/protocol'
import type { CodeRunner, RunOptions } from '../../sandbox/types'
import { ToolRegistry } from '../registry'
import { ToolNotFoundError } from '../types'
import { createCodeToolProvider } from './code'
import type { CodeToolRunners } from './code'

const CALL = { toolCallId: 'call-1', messages: [], context: {} }

function recordingRunner(label: string, calls: Array<{ source: string; options: RunOptions }>): CodeRunner {
  return {
    run: async (source, options) => {
      calls.push({ source, options })
      return { stdout: `${label}:${source}`, stderr: '', result: null }
    },
  }
}

function runners(calls: Array<{ source: string; options: RunOptions }>): CodeToolRunners {
  return { js: recordingRunner('js', calls), python: recordingRunner('py', calls) }
}

/** A mutable source whose current runners and enabled flag can be swapped. */
function source(initial: CodeToolRunners) {
  let current = initial
  let enabled = true
  return {
    getRunners: () => current,
    isEnabled: () => enabled,
    setRunners: (next: CodeToolRunners) => {
      current = next
    },
    setEnabled: (next: boolean) => {
      enabled = next
    },
  }
}

function executor(toolSet: ToolSet, name: string) {
  const execute = toolSet[name]?.execute
  if (!execute) throw new Error(`missing execute for ${name}`)
  return execute
}

describe('createCodeToolProvider', () => {
  it('exposes run_js and run_python', () => {
    const calls: Array<{ source: string; options: RunOptions }> = []
    const provider = createCodeToolProvider(source(runners(calls)))
    const registry = new ToolRegistry()
    registry.registerProvider(provider)
    expect(Object.keys(registry.buildToolSet(undefined, {}))).toEqual(['run_js', 'run_python'])
  })

  it('runs JavaScript through the js runner', async () => {
    const calls: Array<{ source: string; options: RunOptions }> = []
    const provider = createCodeToolProvider(source(runners(calls)))
    const registry = new ToolRegistry()
    registry.registerProvider(provider)
    const set = registry.buildToolSet(['run_js'], {})
    await expect(executor(set, 'run_js')({ source: '1+1' }, CALL)).resolves.toMatchObject({
      ok: true,
      code: 'ok',
      value: { stdout: 'js:1+1' },
    })
    expect(calls).toEqual([{ source: '1+1', options: {} }])
  })

  it('runs Python through the python runner', async () => {
    const calls: Array<{ source: string; options: RunOptions }> = []
    const provider = createCodeToolProvider(source(runners(calls)))
    const registry = new ToolRegistry()
    registry.registerProvider(provider)
    const set = registry.buildToolSet(['run_python'], {})
    await expect(executor(set, 'run_python')({ source: 'print(1)' }, CALL)).resolves.toMatchObject({
      ok: true,
      code: 'ok',
      value: { stdout: 'py:print(1)' },
    })
  })

  it('wraps a runner timeout in a timeout envelope', async () => {
    const failing: CodeToolRunners = {
      js: { run: async () => Promise.reject(new SandboxTimeoutError()) },
      python: { run: async () => Promise.reject(new SandboxTimeoutError()) },
    }
    const provider = createCodeToolProvider(source(failing))
    const registry = new ToolRegistry()
    registry.registerProvider(provider)
    const set = registry.buildToolSet(['run_js'], {})
    await expect(executor(set, 'run_js')({ source: 'while(true){}' }, CALL)).resolves.toMatchObject({
      ok: false,
      code: 'timeout',
    })
  })

  it('wraps a RunResult error in a runtime_error envelope', async () => {
    const errored: CodeToolRunners = {
      js: { run: async () => ({ stdout: '', stderr: '', result: null, error: 'boom' }) },
      python: { run: async () => ({ stdout: '', stderr: '', result: null, error: 'boom' }) },
    }
    const provider = createCodeToolProvider(source(errored))
    const registry = new ToolRegistry()
    registry.registerProvider(provider)
    const set = registry.buildToolSet(['run_js'], {})
    await expect(executor(set, 'run_js')({ source: 'throw new Error()' }, CALL)).resolves.toMatchObject({
      ok: false,
      code: 'runtime_error',
      message: 'boom',
      value: { error: 'boom' },
    })
  })

  it('rejects an unknown tool name', () => {
    const calls: Array<{ source: string; options: RunOptions }> = []
    const provider = createCodeToolProvider(source(runners(calls)))
    expect(() => provider.create('nope', {})).toThrow(ToolNotFoundError)
  })

  it('removes the code tools from the available pool when disabled', () => {
    const calls: Array<{ source: string; options: RunOptions }> = []
    const live = source(runners(calls))
    const provider = createCodeToolProvider(live)
    const registry = new ToolRegistry()
    registry.registerProvider(provider)

    expect(registry.availableNames({})).toEqual(['run_js', 'run_python'])
    live.setEnabled(false)
    expect(registry.availableNames({})).toEqual([])
    live.setEnabled(true)
    expect(registry.availableNames({})).toEqual(['run_js', 'run_python'])
  })

  it('uses a swapped runner on the next call without re-registering', async () => {
    const calls: Array<{ source: string; options: RunOptions }> = []
    const live = source(runners(calls))
    const provider = createCodeToolProvider(live)
    const registry = new ToolRegistry()
    registry.registerProvider(provider)
    const set = registry.buildToolSet(['run_js'], {})

    live.setRunners({ js: recordingRunner('swapped', calls), python: recordingRunner('py', calls) })

    await expect(executor(set, 'run_js')({ source: 'x' }, CALL)).resolves.toMatchObject({
      ok: true,
      value: { stdout: 'swapped:x' },
    })
  })
})
