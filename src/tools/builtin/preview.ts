import { jsonSchema, tool } from 'ai'
import {
  collectLocalRefs,
  diagnoseContent,
  extensionOf,
  resolveLocalRef,
} from '../../workspace/diagnostics'
import { WorkspaceLimitError, WorkspaceNotFoundError } from '../../workspace/errors'
import { toolFail, toolOk, wrapToolExecute } from '../result'
import { ToolNotFoundError, ToolRuntimeUnavailableError } from '../types'
import type { Diagnostic } from '../../workspace/diagnostics'
import type { ToolProvider, ToolRuntimePorts } from '../types'

const NAMES = ['open_preview'] as const

const CHECKABLE = new Set(['html', 'htm', 'json', 'js', 'mjs', 'cjs', 'mmd', 'mermaid'])

async function diagnosticsFor(
  workspace: NonNullable<ToolRuntimePorts['workspace']>,
  path: string,
): Promise<{ kind: string; ok: boolean; errors: Diagnostic[]; warnings: Diagnostic[] } | undefined> {
  const extension = extensionOf(path)
  if (extension === undefined || !CHECKABLE.has(extension)) return undefined
  let content: string
  try {
    content = await workspace.readFile(path)
  } catch (error) {
    // A file past the read cap still opens; diagnostics are simply unavailable.
    if (error instanceof WorkspaceLimitError) return undefined
    throw error
  }
  const result = diagnoseContent(path, content)
  const errors = [...result.errors]
  if (result.kind === 'html') {
    for (const ref of collectLocalRefs(content)) {
      const target = resolveLocalRef(path, ref)
      if (target === null) continue
      try {
        await workspace.stat(target)
      } catch (error) {
        if (error instanceof WorkspaceNotFoundError) {
          errors.push({ message: `Referenced file "${ref}" resolves to "${target}", which is missing.` })
          continue
        }
        throw error
      }
    }
  }
  return { kind: result.kind, ok: errors.length === 0, errors, warnings: result.warnings }
}

/**
 * A navigational tool: it performs a read-only `stat` and asks the UI to show
 * the file. It is deliberately not gated, because it changes no disk state and
 * the user can always close the panel. It refuses a directory and a missing
 * path, so a bad call cannot blank the panel.
 */
export function createPreviewToolProvider(): ToolProvider {
  return {
    names: NAMES,
    isAvailable: (ports) => ports.workspace !== undefined && ports.preview !== undefined,
    create(name, ports) {
      switch (name) {
        case 'open_preview':
          return tool({
            description:
              'Open a workspace file in the File panel so the user can see the result. Call this immediately after writing or editing a file the user would want to look at: HTML, Markdown, JSON, or a Mermaid diagram (.mmd/.mermaid). The path is relative to the workspace folder and the file must already exist. For checkable artifacts (HTML, JSON, JS, Mermaid) the response also reports static diagnostics — `ok`, `errors`, and `warnings` — so you can catch a broken artifact without asking the user to look.',
            inputSchema: jsonSchema<{ path: string }>({
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            } as Parameters<typeof jsonSchema>[0]),
            execute: wrapToolExecute(async (input) => {
              const workspace = ports.workspace ?? undefined
              if (!workspace) throw new ToolRuntimeUnavailableError(name)
              const info = await workspace.stat(input.path)
              if (info.kind === 'directory') {
                return toolFail('invalid_input', `${info.path} is a directory, not a file.`, {
                  hint: 'Pass the path of a file to preview.',
                })
              }
              const preview = ports.preview
              if (!preview) throw new ToolRuntimeUnavailableError(name)
              preview.open(info.path)
              const diagnostics = await diagnosticsFor(workspace, info.path)
              return toolOk({
                path: info.path,
                opened: true,
                ...(diagnostics === undefined ? {} : { diagnostics }),
              })
            }),
          })
        default:
          throw new ToolNotFoundError(name)
      }
    },
  }
}
