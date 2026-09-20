import { executeHttpTool } from './http'
import { toolFail, toolOk } from './result'
import type { ToolResult } from './result'
import { ToolRuntimeUnavailableError } from './types'
import type { ToolDefinition, ToolRuntimePorts } from './types'

export function bindInput(source: string, input: unknown): string {
  return `const input = ${JSON.stringify(input ?? null)};\n${source}`
}

export async function executeUserTool(
  definition: ToolDefinition,
  input: unknown,
  ports: ToolRuntimePorts,
): Promise<ToolResult> {
  if (definition.kind === 'http') {
    return executeHttpTool(definition.request, input, ports.fetch)
  }
  if (!ports.codeRunner) throw new ToolRuntimeUnavailableError(definition.name)
  const result = await ports.codeRunner.run(bindInput(definition.source, input), {
    timeoutMs: definition.timeoutMs,
    ...(ports.journal ? { journal: ports.journal } : {}),
  })
  if (result.error !== undefined) {
    return toolFail('runtime_error', result.error, { value: result })
  }
  return toolOk(result)
}
