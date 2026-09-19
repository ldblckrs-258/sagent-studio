import { describe, expect, it } from 'vitest'
import type { ToolSet } from 'ai'
import type { CodeRunner, RunOptions } from '../../sandbox/types'
import { ToolRegistry } from '../registry'
import { ToolNotFoundError } from '../types'
import { createCodeToolProvider } from './code'

const CALL = { toolCallId: 'call-1', messages: [], context: {} }

function recordingRunner(label: string, calls: Array<{ source: string; options: RunOptions }>): CodeRunner {
  return {
    run: async (source, options) => {
      calls.push({ source, options })
      return { stdout: `${label}:${source}`, stderr: '', result: null }
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
    const provider = createCodeToolProvider({
      js: recordingRunner('js', calls),
      python: recordingRunner('py', calls),
    })
    const registry = new ToolRegistry()
    registry.registerProvider(provider)
    expect(Object.keys(registry.buildToolSet(undefined, {}))).toEqual(['run_js', 'run_python'])
  })

  it('runs JavaScript through the js runner', async () => {
    const calls: Array<{ source: string; options: RunOptions }> = []
    const provider = createCodeToolProvider({
      js: recordingRunner('js', calls),
      python: recordingRunner('py', calls),
    })
    const registry = new ToolRegistry()
    registry.registerProvider(provider)
    const set = registry.buildToolSet(['run_js'], {})
    await expect(executor(set, 'run_js')({ source: '1+1' }, CALL)).resolves.toMatchObject({
      stdout: 'js:1+1',
    })
    expect(calls).toEqual([{ source: '1+1', options: {} }])
  })

  it('runs Python through the python runner', async () => {
    const calls: Array<{ source: string; options: RunOptions }> = []
    const provider = createCodeToolProvider({
      js: recordingRunner('js', calls),
      python: recordingRunner('py', calls),
    })
    const registry = new ToolRegistry()
    registry.registerProvider(provider)
    const set = registry.buildToolSet(['run_python'], {})
    await expect(executor(set, 'run_python')({ source: 'print(1)' }, CALL)).resolves.toMatchObject({
      stdout: 'py:print(1)',
    })
  })

  it('rejects an unknown tool name', () => {
    const calls: Array<{ source: string; options: RunOptions }> = []
    const provider = createCodeToolProvider({
      js: recordingRunner('js', calls),
      python: recordingRunner('py', calls),
    })
    expect(() => provider.create('nope', {})).toThrow(ToolNotFoundError)
  })
})
