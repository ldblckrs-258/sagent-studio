import { jsonSchema, tool } from 'ai'
import { WorkspaceLimitError } from '../../workspace/errors'
import { DEFAULT_RECURSIVE_MAX_ENTRIES } from '../../workspace/fs'
import { countLines, sliceLines, splitLines } from '../../workspace/lines'
import { planPatch } from '../../workspace/patch'
import { SearchRequestError } from '../../workspace/search-protocol'
import { toolFail, toolOk, wrapToolExecute } from '../result'
import { ToolNotFoundError, ToolRuntimeUnavailableError } from '../types'
import type {
  ToolProvider,
  ToolRuntimePorts,
  WorkspaceListOptions,
  WorkspaceSearchOptions,
} from '../types'

const NAMES = [
  'list_dir',
  'read_file',
  'write_file',
  'make_dir',
  'remove',
  'stat',
  'file_info',
  'edit_file',
  'search',
  'move',
  'copy',
] as const

function transferSchema(): Parameters<typeof jsonSchema>[0] {
  return {
    type: 'object',
    properties: { from: { type: 'string' }, to: { type: 'string' } },
    required: ['from', 'to'],
  } as Parameters<typeof jsonSchema>[0]
}

type InputRecord = Record<string, unknown>

function asRecord(input: unknown): InputRecord {
  return typeof input === 'object' && input !== null ? (input as InputRecord) : {}
}

function inputPath(input: unknown): string {
  const path = asRecord(input).path
  return typeof path === 'string' ? path : ''
}

function inputString(input: unknown, key: string): string | undefined {
  const value = asRecord(input)[key]
  return typeof value === 'string' ? value : undefined
}

function inputBoolean(input: unknown, key: string): boolean | undefined {
  const value = asRecord(input)[key]
  return typeof value === 'boolean' ? value : undefined
}

function inputNumber(input: unknown, key: string): number | undefined {
  const value = asRecord(input)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function pathSchema(required: boolean): Parameters<typeof jsonSchema>[0] {
  return {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: required ? ['path'] : [],
  } as Parameters<typeof jsonSchema>[0]
}

function extensionOf(path: string): string | undefined {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : undefined
}

function nonEmptyLineCount(text: string): number {
  return splitLines(text).filter((line) => line.trim().length > 0).length
}

async function fileMetadata(
  workspace: NonNullable<ToolRuntimePorts['workspace']>,
  path: string,
) {
  const info = await workspace.stat(path)
  const shared = {
    path: info.path,
    kind: info.kind,
    size: info.size,
    ...(info.lastModified === undefined ? {} : { lastModified: info.lastModified }),
  }
  if (info.kind === 'directory') return shared
  const extension = extensionOf(info.path)
  let lines: number | null = null
  let nonEmptyLines: number | null = null
  let characters: number | null = null
  try {
    const content = await workspace.readFile(info.path)
    lines = countLines(content)
    nonEmptyLines = nonEmptyLineCount(content)
    characters = content.length
  } catch (error) {
    // A file past the read cap still has useful size metadata; report counts as
    // null rather than failing the whole call.
    if (!(error instanceof WorkspaceLimitError)) throw error
  }
  return {
    ...shared,
    ...(extension === undefined ? {} : { extension }),
    lines,
    nonEmptyLines,
    characters,
  }
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
          inputSchema: jsonSchema<{
            path?: string
            recursive?: boolean
            glob?: string
            maxEntries?: number
          }>({
            type: 'object',
            properties: {
              path: { type: 'string' },
              recursive: { type: 'boolean' },
              glob: { type: 'string' },
              maxEntries: { type: 'integer', minimum: 1 },
            },
          } as Parameters<typeof jsonSchema>[0]),
          execute: wrapToolExecute(async (input) => {
            const path = inputPath(input)
            const recursive = inputBoolean(input, 'recursive') === true
            const glob = inputString(input, 'glob')
            const requestedMax = inputNumber(input, 'maxEntries')
            const maxEntries = requestedMax ?? (recursive ? DEFAULT_RECURSIVE_MAX_ENTRIES : undefined)
            const options: WorkspaceListOptions = {
              ...(recursive ? { recursive: true } : {}),
              ...(glob === undefined ? {} : { glob }),
              ...(maxEntries === undefined ? {} : { maxEntries }),
            }
            const entries = await workspace.list(path, options)
            return toolOk({
              path,
              entries: entries.map((entry) => ({
                name: entry.name,
                path: entry.path,
                kind: entry.kind,
              })),
              truncated: maxEntries !== undefined && entries.length >= maxEntries,
            })
          }),
        })
      case 'read_file':
        return tool({
          description: 'Read a UTF-8 text file from the workspace folder.',
          inputSchema: jsonSchema<{ path: string; offset?: number; limit?: number }>({
            type: 'object',
            properties: {
              path: { type: 'string' },
              offset: { type: 'integer', minimum: 1 },
              limit: { type: 'integer', minimum: 1 },
            },
            required: ['path'],
          } as Parameters<typeof jsonSchema>[0]),
          execute: wrapToolExecute(async (input) => {
            const path = inputPath(input)
            const offset = inputNumber(input, 'offset')
            const limit = inputNumber(input, 'limit')
            const window = sliceLines(await workspace.readFile(path), {
              ...(offset === undefined ? {} : { offset }),
              ...(limit === undefined ? {} : { limit }),
            })
            return toolOk({
              path,
              content: window.content,
              totalLines: window.totalLines,
              returnedLines: window.returnedLines,
              offset: window.offset,
              truncated: window.truncated,
            })
          }),
        })
      case 'write_file':
        return tool({
          description: 'Write UTF-8 text to a workspace file, creating parent directories.',
          inputSchema: jsonSchema<{ path: string; content: string }>({
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          } as Parameters<typeof jsonSchema>[0]),
          execute: wrapToolExecute(async (input) => {
            const path = inputPath(input)
            const content = inputString(input, 'content') ?? ''
            await workspace.writeFile(path, content)
            return { path, bytes: new TextEncoder().encode(content).byteLength }
          }),
        })
      case 'make_dir':
        return tool({
          description: 'Create a directory inside the workspace folder.',
          inputSchema: jsonSchema<{ path: string }>(pathSchema(true)),
          execute: wrapToolExecute(async (input) => {
            const path = inputPath(input)
            await workspace.makeDir(path)
            return { path, created: true }
          }),
        })
      case 'remove':
        return tool({
          description: 'Remove a file or directory recursively from the workspace folder.',
          inputSchema: jsonSchema<{ path: string }>(pathSchema(true)),
          execute: wrapToolExecute(async (input) => {
            const path = inputPath(input)
            await workspace.remove(path)
            return { path, removed: true }
          }),
        })
      case 'stat':
        return tool({
          description: 'Return the kind and size of a file or directory in the workspace folder.',
          inputSchema: jsonSchema<{ path: string }>(pathSchema(true)),
          execute: wrapToolExecute(async (input) => {
            const info = await workspace.stat(inputPath(input))
            return { path: info.path, kind: info.kind, size: info.size }
          }),
        })
      case 'file_info':
        return tool({
          description:
            'Report metadata for a workspace file or directory: byte size, line and character counts, extension, and last-modified time.',
          inputSchema: jsonSchema<{ path: string }>(pathSchema(true)),
          execute: wrapToolExecute(async (input) => fileMetadata(workspace, inputPath(input))),
        })
      case 'edit_file':
        return tool({
          description:
            'Replace an exact string in a workspace file. Writes only on a unique match unless replace_all is true.',
          inputSchema: jsonSchema<{
            path: string
            old_string: string
            new_string: string
            replace_all?: boolean
          }>({
            type: 'object',
            properties: {
              path: { type: 'string' },
              old_string: { type: 'string' },
              new_string: { type: 'string' },
              replace_all: { type: 'boolean' },
            },
            required: ['path', 'old_string', 'new_string'],
          } as Parameters<typeof jsonSchema>[0]),
          execute: wrapToolExecute(async (input) => {
            const path = inputPath(input)
            const oldString = inputString(input, 'old_string') ?? ''
            const newString = inputString(input, 'new_string') ?? ''
            const replaceAll = inputBoolean(input, 'replace_all') === true
            const content = await workspace.readFile(path)
            const beforeBytes = new TextEncoder().encode(content).byteLength
            const plan = planPatch(content, oldString, newString, replaceAll)
            if (!plan.ok) {
              return toolFail(plan.code, plan.message, {
                ...(plan.hint === undefined ? {} : { hint: plan.hint }),
              })
            }
            if (plan.replacements > 0) await workspace.writeFile(path, plan.content)
            const afterBytes = new TextEncoder().encode(plan.content).byteLength
            return toolOk({
              path,
              replacements: plan.replacements,
              linesChanged: plan.linesChanged,
              bytesWritten: plan.replacements > 0 ? afterBytes : 0,
              bytesDelta: plan.replacements > 0 ? afterBytes - beforeBytes : 0,
            })
          }),
        })
      case 'search':
        return tool({
          description:
            'Search the workspace for a regular expression and return at most max_results matching lines.',
          inputSchema: jsonSchema<{
            pattern: string
            ignore_case?: boolean
            path?: string
            max_results?: number
          }>({
            type: 'object',
            properties: {
              pattern: { type: 'string' },
              ignore_case: { type: 'boolean' },
              path: { type: 'string' },
              max_results: { type: 'integer', minimum: 1 },
            },
            required: ['pattern'],
          } as Parameters<typeof jsonSchema>[0]),
          execute: wrapToolExecute(async (input) => {
            const pattern = inputString(input, 'pattern') ?? ''
            const ignoreCase = inputBoolean(input, 'ignore_case') === true
            const searchPath = inputString(input, 'path')
            const maxResults = inputNumber(input, 'max_results')
            const options: WorkspaceSearchOptions = {
              pattern,
              ...(ignoreCase ? { ignoreCase: true } : {}),
              ...(searchPath === undefined ? {} : { path: searchPath }),
              ...(maxResults === undefined ? {} : { maxResults }),
            }
            try {
              const result = await workspace.search(options)
              return toolOk({
                hits: result.hits.map((hit) => ({ path: hit.path, line: hit.line, text: hit.text })),
                filesScanned: result.filesScanned,
                filesSkipped: result.filesSkipped,
                truncated: result.truncated,
              })
            } catch (error) {
              if (error instanceof SearchRequestError) {
                return toolFail(error.code, error.message, {
                  ...(error.hint === undefined ? {} : { hint: error.hint }),
                })
              }
              throw error
            }
          }),
        })
      case 'move':
        return tool({
          description:
            'Move or rename a file or directory in the workspace. Fails if the destination already exists.',
          inputSchema: jsonSchema<{ from: string; to: string }>(transferSchema()),
          execute: wrapToolExecute(async (input) => {
            const result = await workspace.move(
              inputString(input, 'from') ?? '',
              inputString(input, 'to') ?? '',
            )
            return toolOk({ from: result.from, to: result.to, kind: result.kind, size: result.size })
          }),
        })
      case 'copy':
        return tool({
          description:
            'Copy a file or directory in the workspace, leaving the source in place. Fails if the destination already exists.',
          inputSchema: jsonSchema<{ from: string; to: string }>(transferSchema()),
          execute: wrapToolExecute(async (input) => {
            const result = await workspace.copy(
              inputString(input, 'from') ?? '',
              inputString(input, 'to') ?? '',
            )
            return toolOk({ from: result.from, to: result.to, kind: result.kind, size: result.size })
          }),
        })
      default:
        throw new ToolNotFoundError(name)
    }
  },
}
