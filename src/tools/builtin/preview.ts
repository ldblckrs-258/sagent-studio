import { jsonSchema, tool } from 'ai'
import { toolFail, toolOk, wrapToolExecute } from '../result'
import { ToolNotFoundError, ToolRuntimeUnavailableError } from '../types'
import type { ToolProvider } from '../types'

const NAMES = ['open_preview'] as const

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
              'Open a workspace file in the File panel so the user can see the result. Call this immediately after writing or editing a file the user would want to look at: HTML, Markdown, JSON, or a Mermaid diagram (.mmd/.mermaid). The path is relative to the workspace folder and the file must already exist.',
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
              return toolOk({ path: info.path, opened: true })
            }),
          })
        default:
          throw new ToolNotFoundError(name)
      }
    },
  }
}
