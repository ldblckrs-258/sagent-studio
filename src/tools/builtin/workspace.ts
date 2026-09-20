import { jsonSchema, tool } from 'ai'
import { WorkspaceLimitError, WorkspaceNotFoundError } from '../../workspace/errors'
import { DEFAULT_RECURSIVE_MAX_ENTRIES } from '../../workspace/fs'
import { workspaceJournal } from '../../workspace/journal'
import { countLines, sliceLines, splitLines } from '../../workspace/lines'
import { withPathLock } from '../../workspace/lock'
import { planPatchMulti } from '../../workspace/patch'
import type { PatchEdit } from '../../workspace/patch'
import { contentHash } from '../../workspace/revision'
import { DEFAULT_EXCLUDED_DIRS } from '../../workspace/search'
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
  'find_lines',
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

/**
 * Normalizes the tool's two accepted edit shapes into one list: a batched
 * `edits` array (atomic, the preferred form) or the legacy top-level
 * `old_string`/`new_string` pair. Returns null when neither is well-formed.
 */
function readEdits(input: unknown): PatchEdit[] | null {
  const record = asRecord(input)
  if (Array.isArray(record.edits)) {
    const edits: PatchEdit[] = []
    for (const entry of record.edits) {
      const edit = asRecord(entry)
      if (typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string') return null
      edits.push({
        oldString: edit.old_string,
        newString: edit.new_string,
        ...(edit.replace_all === true ? { replaceAll: true } : {}),
      })
    }
    return edits.length > 0 ? edits : null
  }
  const oldString = inputString(input, 'old_string')
  const newString = inputString(input, 'new_string')
  if (oldString === undefined || newString === undefined) return null
  return [{ oldString, newString, ...(inputBoolean(input, 'replace_all') === true ? { replaceAll: true } : {}) }]
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

function padLineNumbers(content: string, firstLine: number): string {
  if (content.length === 0) return ''
  const lines = content.split('\n')
  const width = String(firstLine + lines.length - 1).length
  return lines.map((line, index) => `${String(firstLine + index).padStart(width, ' ')}: ${line}`).join('\n')
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

/**
 * Reads a path for journaling. Returns unknown when the content cannot be
 * captured (size cap, binary), so the caller skips the journal entry instead of
 * recording a bogus "absent" state that a restore would trust.
 */
async function readForJournal(
  workspace: NonNullable<ToolRuntimePorts['workspace']>,
  path: string,
): Promise<{ known: boolean; content: string | null }> {
  try {
    return { known: true, content: await workspace.readFile(path) }
  } catch (error) {
    if (error instanceof WorkspaceNotFoundError) return { known: true, content: null }
    if (error instanceof WorkspaceLimitError) return { known: false, content: null }
    throw error
  }
}

function recordMutation(
  kind: 'write' | 'edit' | 'remove',
  path: string,
  before: string | null,
  after: string | null,
): void {
  try {
    workspaceJournal.record({ kind, path, before, after })
  } catch {
    // Journaling is best-effort: a failed record must never fail the mutation.
  }
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
    ...(info.lastModified === undefined
      ? {}
      : {
          lastModified: info.lastModified,
          lastModifiedIso: new Date(info.lastModified).toISOString(),
          ageMs: Math.max(0, Date.now() - info.lastModified),
        }),
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
          description:
            'List the entries of a directory inside the granted workspace folder. `recursive` walks subdirectories. `glob` is matched against each entry\'s returned `path` (which includes the listed path as a prefix): `*` matches within one segment, `?` one character, and `**` any depth, e.g. `**/*.ts`. `maxEntries` bounds the walk.',
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
          description:
            'Read a UTF-8 text file from the workspace folder. Pass `line_numbers` to prefix each line with its 1-based number. The response carries `revision`, a content fingerprint you can return as `expect_revision` on a later edit to detect a stale write.',
          inputSchema: jsonSchema<{
            path: string
            offset?: number
            limit?: number
            line_numbers?: boolean
          }>({
            type: 'object',
            properties: {
              path: { type: 'string' },
              offset: { type: 'integer', minimum: 1 },
              limit: { type: 'integer', minimum: 1 },
              line_numbers: { type: 'boolean' },
            },
            required: ['path'],
          } as Parameters<typeof jsonSchema>[0]),
          execute: wrapToolExecute(async (input) => {
            const path = inputPath(input)
            const offset = inputNumber(input, 'offset')
            const limit = inputNumber(input, 'limit')
            const numbered = inputBoolean(input, 'line_numbers') === true
            const full = await workspace.readFile(path)
            const window = sliceLines(full, {
              ...(offset === undefined ? {} : { offset }),
              ...(limit === undefined ? {} : { limit }),
            })
            const content = numbered ? padLineNumbers(window.content, window.offset) : window.content
            return toolOk({
              path,
              content,
              revision: contentHash(full),
              totalLines: window.totalLines,
              returnedLines: window.returnedLines,
              offset: window.offset,
              firstLine: window.returnedLines > 0 ? window.offset : 0,
              lastLine: window.returnedLines > 0 ? window.offset + window.returnedLines - 1 : 0,
              truncated: window.truncated,
            })
          }),
        })
      case 'write_file':
        return tool({
          description:
            'Write UTF-8 text to a workspace file, creating parent directories. Returns the before/after content revision so a concurrent overwrite is detectable.',
          inputSchema: jsonSchema<{ path: string; content: string }>({
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          } as Parameters<typeof jsonSchema>[0]),
          execute: wrapToolExecute(async (input) => {
            const path = inputPath(input)
            const content = inputString(input, 'content') ?? ''
            return withPathLock(path, async () => {
              const before = await readForJournal(workspace, path)
              await workspace.writeFile(path, content)
              if (before.known) recordMutation('write', path, before.content, content)
              return toolOk({
                path,
                bytes: utf8Bytes(content),
                applied: true,
                before_hash: before.content === null ? null : contentHash(before.content),
                after_hash: contentHash(content),
                revision: contentHash(content),
              })
            })
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
            return withPathLock(path, async () => {
              const journal = await readForJournal(workspace, path).catch(() => ({
                known: false,
                content: null as string | null,
              }))
              await workspace.remove(path)
              if (journal.known) recordMutation('remove', path, journal.content, null)
              return toolOk({ path, removed: true })
            })
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
            'Apply one or more exact-string replacements to a workspace file atomically. Pass `edits: [{old_string, new_string, replace_all?}]` to batch several hunks into a single read-modify-write; the batch is all-or-nothing and applies against one revision, so it is safe to send multiple edits for the same file in one step. Batch `edits` should be used instead of the legacy top-level `old_string`/`new_string` pair. Each edit needs a unique match unless replace_all is true. Pass `expect_revision` from a prior read_file to reject a stale write. The response reports `applied`, `before_hash`, `after_hash`, and `revision`, and returns `already_satisfied` when the desired text was already present.',
          inputSchema: jsonSchema<{
            path: string
            edits?: Array<{ old_string: string; new_string: string; replace_all?: boolean }>
            old_string?: string
            new_string?: string
            replace_all?: boolean
            expect_revision?: string
          }>({
            type: 'object',
            properties: {
              path: { type: 'string' },
              edits: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    old_string: { type: 'string' },
                    new_string: { type: 'string' },
                    replace_all: { type: 'boolean' },
                  },
                  required: ['old_string', 'new_string'],
                },
              },
              old_string: { type: 'string' },
              new_string: { type: 'string' },
              replace_all: { type: 'boolean' },
              expect_revision: { type: 'string' },
            },
            required: ['path'],
          } as Parameters<typeof jsonSchema>[0]),
          execute: wrapToolExecute(async (input) => {
            const path = inputPath(input)
            const edits = readEdits(input)
            if (edits === null) {
              return toolFail(
                'invalid_input',
                'Provide either an "edits" array or the old_string/new_string pair.',
                { hint: 'Each edit needs a non-empty old_string and a new_string.' },
              )
            }
            const expectRevision = inputString(input, 'expect_revision')
            return withPathLock(path, async () => {
              const content = await workspace.readFile(path)
              const beforeHash = contentHash(content)
              if (expectRevision !== undefined && expectRevision !== beforeHash) {
                return toolFail(
                  'stale_write',
                  `The file changed since revision ${expectRevision}.`,
                  {
                    value: { path, expected: expectRevision, actual: beforeHash },
                    hint: `Re-read the file (current revision ${beforeHash}) and retry against its current content.`,
                  },
                )
              }
              const plan = planPatchMulti(content, edits)
              if (!plan.ok) {
                return toolFail(plan.code, plan.message, {
                  ...(plan.hint === undefined ? {} : { hint: plan.hint }),
                  value: {
                    failedIndex: plan.failedIndex,
                    ...(plan.lines === undefined ? {} : { lines: plan.lines }),
                  },
                })
              }
              const applied = plan.replacements > 0
              if (applied) {
                await workspace.writeFile(path, plan.content)
                recordMutation('edit', path, content, plan.content)
              }
              const beforeBytes = utf8Bytes(content)
              const afterBytes = utf8Bytes(plan.content)
              return toolOk({
                path,
                applied,
                before_hash: beforeHash,
                after_hash: contentHash(plan.content),
                revision: contentHash(plan.content),
                replacements: plan.replacements,
                linesChanged: plan.linesChanged,
                bytesWritten: applied ? afterBytes : 0,
                bytesDelta: applied ? afterBytes - beforeBytes : 0,
                edits: plan.edits,
                ...(plan.alreadySatisfied ? { reason: 'already_satisfied' } : {}),
              })
            })
          }),
        })
      case 'search':
        return tool({
          description:
            'Search the workspace for a regular expression and return at most max_results matching lines. `path` must be a directory (use find_lines for one file). The walk is breadth-first with directories visited in alphabetical order, and node_modules, .git, dist, build, coverage, .next and .turbo are skipped unless include_excluded is true. When no hits are found, `skipped` lists up to 50 files that were not scanned and why (size cap, binary, unreadable), so an empty result is never ambiguous.',
          inputSchema: jsonSchema<{
            pattern: string
            ignore_case?: boolean
            path?: string
            max_results?: number
            include_excluded?: boolean
          }>({
            type: 'object',
            properties: {
              pattern: { type: 'string' },
              ignore_case: { type: 'boolean' },
              path: { type: 'string' },
              max_results: { type: 'integer', minimum: 1 },
              include_excluded: { type: 'boolean' },
            },
            required: ['pattern'],
          } as Parameters<typeof jsonSchema>[0]),
          execute: wrapToolExecute(async (input) => {
            const pattern = inputString(input, 'pattern') ?? ''
            const ignoreCase = inputBoolean(input, 'ignore_case') === true
            const searchPath = inputString(input, 'path')
            const maxResults = inputNumber(input, 'max_results')
            const includeExcluded = inputBoolean(input, 'include_excluded') === true
            if (searchPath !== undefined && searchPath !== '' && searchPath !== '.') {
              const info = await workspace.stat(searchPath)
              if (info.kind !== 'directory') {
                return toolFail('invalid_input', `"${searchPath}" is a file, not a directory.`, {
                  hint: 'Pass a directory path, or use find_lines to scan a single file.',
                })
              }
            }
            const options: WorkspaceSearchOptions = {
              pattern,
              ...(ignoreCase ? { ignoreCase: true } : {}),
              ...(searchPath === undefined ? {} : { path: searchPath }),
              ...(maxResults === undefined ? {} : { maxResults }),
              ...(includeExcluded ? {} : { excludedDirs: DEFAULT_EXCLUDED_DIRS }),
            }
            try {
              const result = await workspace.search(options)
              return toolOk({
                hits: result.hits.map((hit) => ({ path: hit.path, line: hit.line, text: hit.text })),
                filesScanned: result.filesScanned,
                filesSkipped: result.filesSkipped,
                truncated: result.truncated,
                skipped: result.skipped ?? [],
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
      case 'find_lines':
        return tool({
          description:
            'Scan one workspace file for lines matching a regular expression without loading the whole file, so it works past the read size cap used by read_file. Prefer this over search when the file is large or you already know the path.',
          inputSchema: jsonSchema<{
            path: string
            pattern: string
            ignore_case?: boolean
            max_results?: number
          }>({
            type: 'object',
            properties: {
              path: { type: 'string' },
              pattern: { type: 'string' },
              ignore_case: { type: 'boolean' },
              max_results: { type: 'integer', minimum: 1 },
            },
            required: ['path', 'pattern'],
          } as Parameters<typeof jsonSchema>[0]),
          execute: wrapToolExecute(async (input) => {
            const path = inputPath(input)
            const pattern = inputString(input, 'pattern') ?? ''
            const ignoreCase = inputBoolean(input, 'ignore_case') === true
            const maxResults = inputNumber(input, 'max_results')
            if (pattern.length === 0) {
              return toolFail('invalid_input', 'pattern must be a non-empty regular expression.')
            }
            if (workspace.findLines) {
              try {
                const result = await workspace.findLines(path, {
                  pattern,
                  ...(ignoreCase ? { ignoreCase: true } : {}),
                  ...(maxResults === undefined ? {} : { maxResults }),
                })
                return toolOk(result)
              } catch (error) {
                if (error instanceof SearchRequestError) {
                  return toolFail(error.code, error.message, {
                    ...(error.hint === undefined ? {} : { hint: error.hint }),
                  })
                }
                throw error
              }
            }
            const full = await workspace.readFile(path)
            const matcher = new RegExp(pattern, ignoreCase ? 'i' : '')
            const hits: Array<{ path: string; line: number; text: string }> = []
            const lines = splitLines(full)
            for (let index = 0; index < lines.length; index += 1) {
              if (maxResults !== undefined && hits.length >= maxResults) break
              matcher.lastIndex = 0
              if (matcher.test(lines[index])) {
                hits.push({ path, line: index + 1, text: lines[index] })
              }
            }
            return toolOk({
              path,
              hits,
              truncated: maxResults !== undefined && hits.length >= maxResults,
            })
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
