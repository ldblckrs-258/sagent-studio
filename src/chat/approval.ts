import { isGatedTool, resolveApprovalStatus } from '../tools/approval'
import type { ApprovalStatus, ToolGateDescriptor } from '../tools/approval'
import type { ApprovalSettings } from '../vault/settings'
import type { ChatMode } from './types'

/**
 * Builds the per-tool `toolApproval` map for one run. Only gated tools and the
 * always-asking `change_mode` tool are listed; every other tool is absent, which
 * the SDK treats as automatically approved.
 */
export function createToolApproval(
  mode: ChatMode,
  settings: ApprovalSettings | undefined,
  tools: readonly ToolGateDescriptor[],
): Record<string, ApprovalStatus> {
  const config: Record<string, ApprovalStatus> = {}
  for (const tool of tools) {
    if (!isGatedTool(tool) && tool.name !== 'change_mode') continue
    config[tool.name] = resolveApprovalStatus(mode, settings, tool)
  }
  return config
}
