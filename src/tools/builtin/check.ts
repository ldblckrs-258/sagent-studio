import { jsonSchema, tool } from 'ai'
import {
  collectLocalRefs,
  diagnoseContent,
  resolveLocalRef,
} from '../../workspace/diagnostics'
import { WorkspaceNotFoundError } from '../../workspace/errors'
import { toolFail, toolOk, wrapToolExecute } from '../result'
import { ToolNotFoundError, ToolRuntimeUnavailableError } from '../types'
import type { ToolProvider } from '../types'

const NAMES = ['check'] as const

function readPath(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const path = (input as { path?: unknown }).path
  return typeof path === 'string' ? path : ''
}

/**
 * A read-only static checker. It gives the model a verifiable verdict about a
 * file it just wrote — unbalanced HTML, broken inline `<script>`, invalid JSON,
 * or a dangling local reference — without needing a browser render.
 */
export function createCheckToolProvider(): ToolProvider {
  return {
    names: NAMES,
    isAvailable: (ports) => ports.workspace !== undefined,
    create(name, ports) {
      switch (name) {
        case 'check':
          return tool({
            description:
              'Statically check one workspace text file and return structured diagnostics. Checks HTML tag balance and inline <script> syntax, JSON validity, and that local script/stylesheet references exist. Use it right after writing or editing an artifact, before open_preview.',
            inputSchema: jsonSchema<{ path: string }>({
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            } as Parameters<typeof jsonSchema>[0]),
            execute: wrapToolExecute(async (input) => {
              const workspace = ports.workspace
              if (!workspace) throw new ToolRuntimeUnavailableError(name)
              const path = readPath(input)
              if (path.length === 0) {
                return toolFail('invalid_input', 'path must be a non-empty workspace path.')
              }
              const content = await workspace.readFile(path)
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
              return toolOk({
                path,
                kind: result.kind,
                ok: errors.length === 0,
                errors,
                warnings: result.warnings,
              })
            }),
          })
        default:
          throw new ToolNotFoundError(name)
      }
    },
  }
}
