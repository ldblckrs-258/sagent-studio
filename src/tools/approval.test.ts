import { describe, expect, it } from 'vitest'
import {
  decisionFor,
  isGatedTool,
  isWithinCeiling,
  modeCeiling,
  normalizeApprovalSettings,
  resolveApprovalStatus,
} from './approval'

describe('isGatedTool', () => {
  it('gates each named destructive built-in', () => {
    for (const name of ['write_file', 'remove', 'edit_file', 'move', 'run_js', 'run_python']) {
      expect(isGatedTool(name), name).toBe(true)
    }
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
        'list_dir',
        'load_skill',
        'list_skills',
        'list_user_tools',
        'open_preview',
        'read_file',
        'search',
        'stat',
        'update_plan',
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
    expect(resolveApprovalStatus('editing', { tools: {} }, 'write_file')).toBe('user-approval')
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

  it('approves an allowed tool within the ceiling', () => {
    expect(resolveApprovalStatus('editing', { tools: { write_file: 'allow' } }, 'write_file')).toBe(
      'approved',
    )
    expect(resolveApprovalStatus('editing', { tools: {} }, 'make_dir')).toBe('approved')
  })
})
