import { COMMAND_TOOLS, isGatedTool, resolveApprovalStatus } from '../tools/approval'
import type { ApprovalStatus, ToolGateDescriptor } from '../tools/approval'
import { commandApprovalFor, createCommandLane } from '../terminal/approval'
import type { CommandApprovalResult } from '../terminal/approval'
import type { TerminalPort } from '../terminal/types'
import type { ApprovalSettings } from '../vault/settings'
import type { ChatMode } from './types'

export type CommandApprovalFunction = (
  input: unknown,
  options: { toolCallId: string; messages: readonly unknown[] },
) => Promise<CommandApprovalResult>

export interface CommandApprovalScope {
  port: TerminalPort
  threadId: string
}

/**
 * Builds the per-tool `toolApproval` map for one run. Only gated tools and the
 * always-asking `change_mode` tool are listed; every other tool is absent, which
 * the SDK treats as automatically approved.
 */
export function createToolApproval(
  mode: ChatMode,
  settings: ApprovalSettings | undefined,
  tools: readonly ToolGateDescriptor[],
  command?: CommandApprovalScope,
): Record<string, ApprovalStatus | CommandApprovalFunction> {
  const config: Record<string, ApprovalStatus | CommandApprovalFunction> = {}
  const lane = createCommandLane()
  for (const tool of tools) {
    if (!isGatedTool(tool) && tool.name !== 'change_mode') continue
    if (COMMAND_TOOLS.has(tool.name)) {
      const name = tool.name
      config[name] = command
        ? (input, options) =>
            lane(options.messages.length, () =>
              commandApprovalFor(
                command.port,
                { threadId: command.threadId, mode, settings },
                name,
                input,
                options.toolCallId,
              ),
            )
        : 'denied'
      continue
    }
    config[tool.name] = resolveApprovalStatus(mode, settings, tool)
  }
  return config
}
