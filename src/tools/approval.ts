import type { ChatMode } from '../chat/types'
import { DEFAULT_APPROVAL_DECISION } from '../vault/settings'
import type { ApprovalDecision, ApprovalSettings } from '../vault/settings'

export type ToolGateKind = 'builtin' | 'sandbox-js' | 'http'

export interface ToolGateDescriptor {
  name: string
  kind?: ToolGateKind
}

export type ApprovalStatus = 'approved' | 'denied' | 'user-approval'

const GATED_BUILTINS = new Set([
  'write_file',
  'remove',
  'edit_file',
  'move',
  'run_js',
  'run_python',
  'create_skill',
  'update_skill',
  'delete_skill',
  'create_tool',
  'update_tool',
  'delete_tool',
])

const READ_ONLY_TOOLS = new Set([
  'list_dir',
  'read_file',
  'stat',
  'file_info',
  'search',
  'open_preview',
  'load_skill',
  'update_plan',
  'change_mode',
  'list_skills',
  'list_user_tools',
])

const EDITING_TOOLS = new Set([
  ...READ_ONLY_TOOLS,
  'write_file',
  'edit_file',
  'make_dir',
  'copy',
  'move',
  'run_js',
  'run_python',
  'create_skill',
  'update_skill',
  'delete_skill',
  'create_tool',
  'update_tool',
  'delete_tool',
])

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function nameOf(tool: string | ToolGateDescriptor): string {
  return typeof tool === 'string' ? tool : tool.name
}

function isUserCodeOrNetwork(tool: string | ToolGateDescriptor): boolean {
  return (
    typeof tool !== 'string' && (tool.kind === 'sandbox-js' || tool.kind === 'http')
  )
}

/** The named destructive built-ins plus any user tool that runs code or reaches the network. */
export function isGatedTool(tool: string | ToolGateDescriptor): boolean {
  if (GATED_BUILTINS.has(nameOf(tool))) return true
  return isUserCodeOrNetwork(tool)
}

export function decisionFor(
  settings: ApprovalSettings | undefined,
  toolName: string,
): ApprovalDecision {
  const value = settings?.tools?.[toolName]
  return value === 'allow' || value === 'deny' || value === 'ask'
    ? value
    : DEFAULT_APPROVAL_DECISION
}

export function normalizeApprovalSettings(
  raw: unknown,
  isKnown: (name: string) => boolean = () => true,
): ApprovalSettings {
  const tools: Record<string, ApprovalDecision> = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { tools }
  const rawTools = (raw as { tools?: unknown }).tools
  if (typeof rawTools !== 'object' || rawTools === null || Array.isArray(rawTools)) {
    return { tools }
  }
  for (const [name, decision] of Object.entries(rawTools)) {
    if (FORBIDDEN_KEYS.has(name)) continue
    if (name.length === 0 || name.length > 64) continue
    if (!isKnown(name)) continue
    if (decision !== 'allow' && decision !== 'ask' && decision !== 'deny') continue
    tools[name] = decision
  }
  return { tools }
}

/** The exact tool-name set a mode permits; `'all'` for `god`. */
export function modeCeiling(mode: ChatMode): ReadonlySet<string> | 'all' {
  if (mode === 'god') return 'all'
  return mode === 'read_only' ? READ_ONLY_TOOLS : EDITING_TOOLS
}

export function isWithinCeiling(mode: ChatMode, tool: string | ToolGateDescriptor): boolean {
  const ceiling = modeCeiling(mode)
  if (ceiling === 'all') return true
  if (ceiling.has(nameOf(tool))) return true
  return isUserCodeOrNetwork(tool)
}

/**
 * `decision = max(modeCeiling, policy)`: a persisted `deny` wins over the mode,
 * `god` auto-approves every gated tool, `change_mode` always asks, and a tool
 * above the mode's ceiling escalates to a per-call accept.
 */
export function resolveApprovalStatus(
  mode: ChatMode,
  settings: ApprovalSettings | undefined,
  tool: string | ToolGateDescriptor,
): ApprovalStatus {
  const name = nameOf(tool)
  if (name === 'change_mode') return 'user-approval'
  if (decisionFor(settings, name) === 'deny') return 'denied'
  if (mode === 'god') return 'approved'
  if (!isWithinCeiling(mode, tool)) return 'user-approval'
  if (!isGatedTool(tool)) return 'approved'
  return decisionFor(settings, name) === 'allow' ? 'approved' : 'user-approval'
}
