import { jsonSchema, tool } from 'ai'
import { ToolNotFoundError, ToolRuntimeUnavailableError } from '../types'
import type { ToolProvider, ToolRuntimePorts } from '../types'

const NAMES = ['list_dir', 'read_file', 'write_file', 'make_dir', 'remove'] as const

function inputPath(input: unknown): string {
  if (typeof input === 'object' && input !== null) {
    const path = (input as { path?: unknown }).path
    if (typeof path === 'string') return path
  }
  return ''
}

function pathSchema(required: boolean): Parameters<typeof jsonSchema>[0] {
  return {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: required ? ['path'] : [],
  } as Parameters<typeof jsonSchema>[0]
}

export const workspaceToolProvider: ToolProvider = {
  names: NAMES,
  isAvailable: (ports: ToolRuntimePorts) => ports.workspace !== undefined,
  create(name, ports) {
    const workspace = ports.workspace
    if (!workspace) throw new ToolRuntimeUnavailableError(name)

    switch (name) {
      case 'list_dir':
        return tool({
          description: 'List the entries of a directory inside the granted workspace folder.',
          inputSchema: jsonSchema<{ path?: string }>(pathSchema(false)),
          execute: async (input) => {
            const path = inputPath(input)
            const entries = await workspace.list(path)
            return {
              path,
              entries: entries.map((entry) => ({
                name: entry.name,
                path: entry.path,
                kind: entry.kind,
              })),
            }
          },
        })
      case 'read_file':
        return tool({
          description: 'Read a UTF-8 text file from the workspace folder.',
          inputSchema: jsonSchema<{ path: string }>(pathSchema(true)),
          execute: async (input) => {
            const path = inputPath(input)
            return { path, content: await workspace.readFile(path) }
          },
        })
      case 'write_file':
        return tool({
          description: 'Write UTF-8 text to a workspace file, creating parent directories.',
          inputSchema: jsonSchema<{ path: string; content: string }>({
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          } as Parameters<typeof jsonSchema>[0]),
          execute: async (input) => {
            const path = inputPath(input)
            const content =
              typeof (input as { content?: unknown })?.content === 'string'
                ? (input as { content: string }).content
                : ''
            await workspace.writeFile(path, content)
            return { path, bytes: new TextEncoder().encode(content).byteLength }
          },
        })
      case 'make_dir':
        return tool({
          description: 'Create a directory inside the workspace folder.',
          inputSchema: jsonSchema<{ path: string }>(pathSchema(true)),
          execute: async (input) => {
            const path = inputPath(input)
            await workspace.makeDir(path)
            return { path, created: true }
          },
        })
      case 'remove':
        return tool({
          description: 'Remove a file or directory recursively from the workspace folder.',
          inputSchema: jsonSchema<{ path: string }>(pathSchema(true)),
          execute: async (input) => {
            const path = inputPath(input)
            await workspace.remove(path)
            return { path, removed: true }
          },
        })
      default:
        throw new ToolNotFoundError(name)
    }
  },
}
