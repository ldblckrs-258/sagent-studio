import { jsonSchema, tool } from 'ai'
import type { CodeRunner } from '../../sandbox/types'
import { ToolNotFoundError } from '../types'
import type { ToolProvider } from '../types'

const NAMES = ['run_js', 'run_python'] as const

function sourceSchema(): Parameters<typeof jsonSchema>[0] {
  return {
    type: 'object',
    properties: { source: { type: 'string' } },
    required: ['source'],
  } as Parameters<typeof jsonSchema>[0]
}

function readSource(input: unknown): string {
  if (typeof input === 'object' && input !== null) {
    const source = (input as { source?: unknown }).source
    if (typeof source === 'string') return source
  }
  return ''
}

export interface CodeToolRunners {
  js: CodeRunner
  python: CodeRunner
}

export function createCodeToolProvider(runners: CodeToolRunners): ToolProvider {
  return {
    names: NAMES,
    isAvailable: () => true,
    create(name) {
      switch (name) {
        case 'run_js':
          return tool({
            description:
              'Run JavaScript in an isolated worker and return its stdout, stderr, and result.',
            inputSchema: jsonSchema<{ source: string }>(sourceSchema()),
            execute: async (input) => runners.js.run(readSource(input), {}),
          })
        case 'run_python':
          return tool({
            description:
              'Run Python in an isolated worker and return its stdout, stderr, and result.',
            inputSchema: jsonSchema<{ source: string }>(sourceSchema()),
            execute: async (input) => runners.python.run(readSource(input), {}),
          })
        default:
          throw new ToolNotFoundError(name)
      }
    },
  }
}
