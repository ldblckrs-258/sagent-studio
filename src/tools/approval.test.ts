import { describe, expect, it } from 'vitest'
import {
  COMMAND_TOOLS,
  decisionFor,
  isGatedTool,
  isWithinCeiling,
  modeCeiling,
  normalizeApprovalSettings,
  resolveApprovalStatus,
} from './approval'

describe('isGatedTool', () => {
  it('gates each named destructive built-in', () => {
    for (const name of ['write_file', 'remove', 'edit_file', 'move', 'restore', 'run_js', 'run_python']) {
      expect(isGatedTool(name), name).toBe(true)
    }
  })

  it('gates the user-tool dispatcher in every mode below god', () => {
    expect(isGatedTool('call_user_tool')).toBe(true)
    expect(resolveApprovalStatus('read_only', undefined, 'call_user_tool')).toBe('user-approval')
    expect(resolveApprovalStatus('editing', undefined, 'call_user_tool')).toBe('user-approval')
    expect(resolveApprovalStatus('god', undefined, 'call_user_tool')).toBe('approved')
    expect(resolveApprovalStatus('editing', { tools: { call_user_tool: 'deny' } }, 'call_user_tool')).toBe(
      'denied',
    )
  })

  it('gates the six harness-management mutations and not the two list tools', () => {
    for (const name of [
      'create_skill',
      'update_skill',
      'delete_skill',
      'create_tool',
      'update_tool',
      'delete_tool',
    ]) {
      expect(isGatedTool(name), name).toBe(true)
    }
    for (const name of ['list_skills', 'list_user_tools']) {
      expect(isGatedTool(name), name).toBe(false)
    }
  })

  it('gates a user sandbox-js or http tool by kind', () => {
    expect(isGatedTool({ name: 'my_tool', kind: 'sandbox-js' })).toBe(true)
    expect(isGatedTool({ name: 'my_tool', kind: 'http' })).toBe(true)
    expect(isGatedTool({ name: 'my_tool', kind: 'builtin' })).toBe(false)
  })

  it('marks every MCP tool as gated, so a saved Ask or Deny applies to it', () => {
    expect(isGatedTool({ name: 'mcp_linear_list_issues', kind: 'mcp' })).toBe(true)
  })

  it('does not gate benign mutators or read tools', () => {
    for (const name of [
      'make_dir',
      'copy',
      'list_dir',
      'read_file',
      'stat',
      'file_info',
      'search',
      'load_skill',
      'update_plan',
      'reset_sandbox',
    ]) {
      expect(isGatedTool(name), name).toBe(false)
    }
  })
})

describe('decisionFor', () => {
  it('defaults to ask and returns a persisted value', () => {
    expect(decisionFor(undefined, 'write_file')).toBe('ask')
    expect(decisionFor({ tools: { write_file: 'allow' } }, 'write_file')).toBe('allow')
  })

  it('coerces an unrecognized persisted value to ask', () => {
    expect(decisionFor({ tools: { write_file: 'other' as never } }, 'write_file')).toBe('ask')
  })
})

describe('normalizeApprovalSettings', () => {
  it('drops forbidden keys, non-decisions, and unknown names', () => {
    const raw = {
      tools: JSON.parse(
        '{"write_file":"allow","make_dir":"ask","bad":"maybe","__proto__":"deny","constructor":"allow"}',
      ),
    }
    const normalized = normalizeApprovalSettings(raw, (name) => name !== 'make_dir')
    expect(normalized.tools).toEqual({ write_file: 'allow' })
  })

  it('never throws on a malformed record', () => {
    expect(normalizeApprovalSettings(null).tools).toEqual({})
    expect(normalizeApprovalSettings('nope').tools).toEqual({})
    expect(normalizeApprovalSettings({ tools: 42 }).tools).toEqual({})
  })
})

describe('modeCeiling and resolveApprovalStatus', () => {
  it('permits exactly the read-only set in read_only', () => {
    const ceiling = modeCeiling('read_only')
    expect(ceiling).not.toBe('all')
    expect([...(ceiling as ReadonlySet<string>)].sort()).toEqual(
      [
        'change_mode',
        'file_info',
        'get_chunk',
        'get_neighbors',
        'list_dir',
        'list_documents',
        'load_skill',
        'list_skills',
        'list_user_tools',
        'open_preview',
        'read_file',
        'search',
        'search_documents',
        'search_skills',
        'read_tool_guide',
        'spawn_agent',
        'message_agent',
        'wait_agents',
        'stat',
        'update_plan',
        'verify_citation',
        'remember',
        'update_memory',
        'forget',
        'recall_memory',
        'list_mcp_resources',
        'read_mcp_resource',
        'terminal_read',
        'terminal_list',
      ].sort(),
    )
    expect((ceiling as ReadonlySet<string>).has('create_skill')).toBe(false)
    expect((ceiling as ReadonlySet<string>).has('delete_tool')).toBe(false)
  })

  it('approves the navigational open_preview tool in every mode', () => {
    expect(resolveApprovalStatus('read_only', { tools: {} }, 'open_preview')).toBe('approved')
    expect(resolveApprovalStatus('editing', { tools: {} }, 'open_preview')).toBe('approved')
    expect(resolveApprovalStatus('god', { tools: {} }, 'open_preview')).toBe('approved')
  })

  it('escalates harness mutations in read_only but approves the list tools', () => {
    expect(resolveApprovalStatus('read_only', { tools: {} }, 'create_skill')).toBe('user-approval')
    expect(resolveApprovalStatus('read_only', { tools: { create_skill: 'allow' } }, 'create_skill')).toBe(
      'user-approval',
    )
    expect(resolveApprovalStatus('read_only', { tools: {} }, 'list_skills')).toBe('approved')
  })

  it('gates harness mutations in editing and auto-approves them in god', () => {
    expect(resolveApprovalStatus('editing', { tools: {} }, 'create_skill')).toBe('user-approval')
    expect(resolveApprovalStatus('editing', { tools: { create_skill: 'allow' } }, 'create_skill')).toBe(
      'approved',
    )
    expect(resolveApprovalStatus('god', { tools: {} }, 'create_skill')).toBe('approved')
    expect(resolveApprovalStatus('god', { tools: { create_skill: 'deny' } }, 'create_skill')).toBe(
      'denied',
    )
  })

  it('escalates a write in read_only even when the policy allows it', () => {
    expect(resolveApprovalStatus('read_only', { tools: { write_file: 'allow' } }, 'write_file')).toBe(
      'user-approval',
    )
    expect(isWithinCeiling('read_only', { name: 'make_dir', kind: 'builtin' })).toBe(false)
  })

  it('escalates remove in editing even when the policy allows it', () => {
    expect(resolveApprovalStatus('editing', { tools: { remove: 'allow' } }, 'remove')).toBe(
      'user-approval',
    )
  })

  it('runs the editing tier file/code tools without a prompt', () => {
    for (const name of ['write_file', 'edit_file', 'move', 'run_js', 'run_python']) {
      expect(resolveApprovalStatus('editing', { tools: {} }, name), name).toBe('approved')
    }
    expect(resolveApprovalStatus('read_only', { tools: {} }, 'write_file')).toBe('user-approval')
    expect(resolveApprovalStatus('editing', { tools: {} }, 'remove')).toBe('user-approval')
  })

  it('always asks before restoring the workspace', () => {
    expect(resolveApprovalStatus('editing', { tools: {} }, 'restore')).toBe('user-approval')
    expect(resolveApprovalStatus('editing', { tools: { restore: 'allow' } }, 'restore')).toBe(
      'approved',
    )
    expect(resolveApprovalStatus('read_only', { tools: {} }, 'restore')).toBe('user-approval')
    expect(resolveApprovalStatus('god', { tools: {} }, 'restore')).toBe('approved')
  })

  it('honors an explicit per-tool ask or deny over the editing tier grant', () => {
    expect(resolveApprovalStatus('editing', { tools: { write_file: 'ask' } }, 'write_file')).toBe(
      'user-approval',
    )
    expect(resolveApprovalStatus('editing', { tools: { run_js: 'deny' } }, 'run_js')).toBe('denied')
  })

  it('escalates user code/network tools in read_only but keeps them asking in editing', () => {
    expect(isWithinCeiling('read_only', { name: 'my_tool', kind: 'sandbox-js' })).toBe(false)
    expect(isWithinCeiling('editing', { name: 'my_tool', kind: 'sandbox-js' })).toBe(true)
    expect(
      resolveApprovalStatus('editing', { tools: {} }, { name: 'fetch_it', kind: 'http' }),
    ).toBe('user-approval')
    expect(
      resolveApprovalStatus('god', { tools: {} }, { name: 'fetch_it', kind: 'http' }),
    ).toBe('approved')
  })

  it('auto-approves gated tools in god but never change_mode', () => {
    expect(resolveApprovalStatus('god', { tools: {} }, 'write_file')).toBe('approved')
    expect(resolveApprovalStatus('god', { tools: {} }, 'change_mode')).toBe('user-approval')
  })

  it('lets a persisted deny win in every mode including god', () => {
    expect(resolveApprovalStatus('god', { tools: { write_file: 'deny' } }, 'write_file')).toBe('denied')
    expect(
      resolveApprovalStatus('read_only', { tools: { write_file: 'deny' } }, 'write_file'),
    ).toBe('denied')
  })

  it('runs the memory tools without a prompt in every mode but honors a persisted deny', () => {
    for (const name of ['remember', 'update_memory', 'forget', 'recall_memory']) {
      expect(isGatedTool(name), name).toBe(false)
      for (const mode of ['read_only', 'editing', 'god'] as const) {
        expect(resolveApprovalStatus(mode, { tools: {} }, name), `${mode} ${name}`).toBe('approved')
        expect(
          resolveApprovalStatus(mode, { tools: { [name]: 'deny' } }, name),
          `${mode} ${name} deny`,
        ).toBe('denied')
      }
    }
  })

  it('approves an allowed tool within the ceiling', () => {
    expect(resolveApprovalStatus('editing', { tools: { write_file: 'allow' } }, 'write_file')).toBe(
      'approved',
    )
    expect(resolveApprovalStatus('editing', { tools: {} }, 'make_dir')).toBe('approved')
  })
})

describe('MCP tools and the approval gate', () => {
  const mcp = { name: 'mcp_linear_create_issue', kind: 'mcp' as const }

  it('runs without a prompt in editing and god, and escalates in read_only', () => {
    expect(resolveApprovalStatus('editing', undefined, mcp)).toBe('approved')
    expect(resolveApprovalStatus('editing', { tools: {} }, mcp)).toBe('approved')
    expect(resolveApprovalStatus('read_only', undefined, mcp)).toBe('user-approval')
    expect(isWithinCeiling('read_only', mcp)).toBe(false)
    expect(isWithinCeiling('editing', mcp)).toBe(true)
    expect(resolveApprovalStatus('god', undefined, mcp)).toBe('approved')
  })

  it('honors a saved Ask or Deny over the editing default, and never lifts read_only', () => {
    expect(resolveApprovalStatus('editing', { tools: { [mcp.name]: 'ask' } }, mcp)).toBe('user-approval')
    expect(resolveApprovalStatus('editing', { tools: { [mcp.name]: 'deny' } }, mcp)).toBe('denied')
    expect(resolveApprovalStatus('god', { tools: { [mcp.name]: 'deny' } }, mcp)).toBe('denied')
    expect(resolveApprovalStatus('read_only', { tools: { [mcp.name]: 'allow' } }, mcp)).toBe(
      'user-approval',
    )
  })
})

describe('terminal tools', () => {
  const commandTools = ['run_command', 'terminal_start', 'terminal_write']

  it('marks the three command tools for per-call classification', () => {
    expect([...COMMAND_TOOLS].sort()).toEqual([...commandTools].sort())
  })

  it('lets read-only list and read sessions but not start, write or kill them', () => {
    expect(resolveApprovalStatus('read_only', undefined, 'terminal_read')).toBe('approved')
    expect(resolveApprovalStatus('read_only', undefined, 'terminal_list')).toBe('approved')
    for (const name of [...commandTools, 'terminal_kill']) {
      expect(resolveApprovalStatus('read_only', undefined, name)).toBe('user-approval')
    }
  })

  it('grants every terminal tool in editing, so editing sub-agents receive them in their pool', () => {
    const ceiling = modeCeiling('editing') as ReadonlySet<string>
    for (const name of [...commandTools, 'terminal_kill', 'terminal_read', 'terminal_list']) {
      expect(ceiling.has(name)).toBe(true)
      expect(resolveApprovalStatus('editing', undefined, name)).toBe('approved')
    }
  })

  it('gates the four mutating terminal tools so a saved Ask or Deny applies', () => {
    for (const name of [...commandTools, 'terminal_kill']) expect(isGatedTool(name)).toBe(true)
    expect(resolveApprovalStatus('god', { tools: { run_command: 'deny' } }, 'run_command')).toBe('denied')
    expect(resolveApprovalStatus('editing', { tools: { terminal_kill: 'ask' } }, 'terminal_kill')).toBe('user-approval')
  })
})
