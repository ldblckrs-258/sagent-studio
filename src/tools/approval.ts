import type { ChatMode } from '../chat/types'
import { DEFAULT_APPROVAL_DECISION } from '../vault/settings'
import type { ApprovalDecision, ApprovalSettings } from '../vault/settings'

export type ToolGateKind = 'builtin' | 'sandbox-js' | 'http' | 'mcp'

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
  'restore',
  'run_js',
  'run_python',
  'create_skill',
  'update_skill',
  'delete_skill',
  'create_tool',
  'update_tool',
  'delete_tool',
  'call_user_tool',
])

const READ_ONLY_TOOLS = new Set([
  'list_dir',
  'read_file',
  'stat',
  'file_info',
  'search',
  'open_preview',
  'load_skill',
  'search_skills',
  'read_tool_guide',
  'spawn_agent',
  'message_agent',
  'wait_agents',
  'update_plan',
  'change_mode',
  'list_skills',
  'list_user_tools',
  'list_documents',
  'search_documents',
  'get_chunk',
  'get_neighbors',
  'verify_citation',
  'remember',
  'update_memory',
  'forget',
  'recall_memory',
  'list_mcp_resources',
  'read_mcp_resource',
])

const EDITING_TOOLS = new Set([
  ...READ_ONLY_TOOLS,
  'write_file',
  'edit_file',
  'make_dir',
  'copy',
  'move',
  'restore',
  'run_js',
  'run_python',
  'create_skill',
  'update_skill',
  'delete_skill',
  'create_tool',
  'update_tool',
  'delete_tool',
])

/**
 * Gated tools inside the editing ceiling that the mode itself consents to run.
 * This is the "write files and run code" tier; harness-management mutations and
 * `remove` stay policy-gated so a delete still asks by default.
 */
const MODE_GRANTED_TOOLS = new Set([
  'write_file',
  'edit_file',
  'move',
  'run_js',
  'run_python',
])

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function nameOf(tool: string | ToolGateDescriptor): string {
  return typeof tool === 'string' ? tool : tool.name
}

function isUserCodeOrNetwork(tool: string | ToolGateDescriptor): boolean {
  return (
    typeof tool !== 'string' &&
    (tool.kind === 'sandbox-js' || tool.kind === 'http' || tool.kind === 'mcp')
  )
}

/** The named destructive built-ins plus any user tool that runs code or reaches the network. */
export function isGatedTool(tool: string | ToolGateDescriptor): boolean {
  if (GATED_BUILTINS.has(nameOf(tool))) return true
  return isUserCodeOrNetwork(tool)
}

/** The persisted decision for a tool, or `undefined` when no policy was stored. */
export function persistedDecision(
  settings: ApprovalSettings | undefined,
  toolName: string,
): ApprovalDecision | undefined {
  const value = settings?.tools?.[toolName]
  return value === 'allow' || value === 'deny' || value === 'ask' ? value : undefined
}

export function decisionFor(
  settings: ApprovalSettings | undefined,
  toolName: string,
): ApprovalDecision {
  return persistedDecision(settings, toolName) ?? DEFAULT_APPROVAL_DECISION
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

/** The permission modes from least to most permissive; the delegation ladder. */
export const MODE_ORDER: readonly ChatMode[] = ['read_only', 'editing', 'god']

/** The index of a mode in the ladder, so two modes can be compared. */
export function modeRank(mode: ChatMode): number {
  return MODE_ORDER.indexOf(mode)
}

/**
 * Caps `requested` at `parent`: a delegated agent may never widen the
 * conversation's permission mode, so a request above the parent's is clamped
 * down to it rather than rejected.
 */
export function clampMode(parent: ChatMode, requested: ChatMode): ChatMode {
  return modeRank(requested) > modeRank(parent) ? parent : requested
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
  return mode === 'editing' && isUserCodeOrNetwork(tool)
}

/**
 * `decision = max(modeCeiling, policy)`: a persisted `deny` wins over the mode,
 * `god` auto-approves every gated tool, `change_mode` always asks, and a tool
 * above the mode's ceiling escalates to a per-call accept. Inside the editing
 * ceiling the file/code tools run without a prompt, while an explicit persisted
 * `ask` still forces one and an explicit `allow` clears any other tool.
 */
export function resolveApprovalStatus(
  mode: ChatMode,
  settings: ApprovalSettings | undefined,
  tool: string | ToolGateDescriptor,
): ApprovalStatus {
  const name = nameOf(tool)
  const persisted = persistedDecision(settings, name)
  if (name === 'change_mode') return 'user-approval'
  if (persisted === 'deny') return 'denied'
  if (mode === 'god') return 'approved'
  if (!isWithinCeiling(mode, tool)) return 'user-approval'
  if (!isGatedTool(tool)) return 'approved'
  if (persisted === 'allow') return 'approved'
  if (persisted === 'ask') return 'user-approval'
  if (typeof tool !== 'string' && tool.kind === 'mcp') return 'approved'
  return MODE_GRANTED_TOOLS.has(name) ? 'approved' : 'user-approval'
}
