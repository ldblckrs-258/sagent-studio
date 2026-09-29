import { describe, expect, it } from 'vitest'
import { createFakePort } from '../terminal/test-utils/fake-port'
import { createToolApproval } from './approval'

describe('createToolApproval', () => {
  const gated = [{ name: 'write_file' }, { name: 'make_dir' }]

  it('grants editing-tier writes and maps allow/ask/deny to the SDK status', () => {
    expect(createToolApproval('editing', { tools: {} }, gated)).toEqual({
      write_file: 'approved',
    })
    expect(createToolApproval('editing', { tools: { write_file: 'allow' } }, gated)).toEqual({
      write_file: 'approved',
    })
    expect(createToolApproval('editing', { tools: { write_file: 'ask' } }, gated)).toEqual({
      write_file: 'user-approval',
    })
    expect(createToolApproval('editing', { tools: { write_file: 'deny' } }, gated)).toEqual({
      write_file: 'denied',
    })
    expect(createToolApproval('read_only', { tools: {} }, gated)).toEqual({
      write_file: 'user-approval',
    })
  })

  it('omits non-gated tools, so an empty policy produces an empty object', () => {
    expect(
      createToolApproval('editing', { tools: {} }, [{ name: 'make_dir' }, { name: 'read_file' }]),
    ).toEqual({})
  })

  it('gates a user sandbox-js or http tool', () => {
    expect(
      createToolApproval('editing', { tools: {} }, [{ name: 'my_tool', kind: 'sandbox-js' }]),
    ).toEqual({ my_tool: 'user-approval' })
    expect(
      createToolApproval('editing', { tools: {} }, [{ name: 'fetch_it', kind: 'http' }]),
    ).toEqual({ fetch_it: 'user-approval' })
  })

  it('always maps change_mode to user-approval, even in god', () => {
    expect(createToolApproval('god', { tools: {} }, [{ name: 'change_mode' }])).toEqual({
      change_mode: 'user-approval',
    })
  })

  it('auto-approves gated tools in god', () => {
    expect(createToolApproval('god', { tools: {} }, gated)).toEqual({
      write_file: 'approved',
    })
  })

  it('gates harness mutations and omits the list tools from the approval map', () => {
    const tools = [
      { name: 'create_skill' },
      { name: 'delete_tool' },
      { name: 'list_skills' },
      { name: 'list_user_tools' },
    ]
    expect(createToolApproval('editing', { tools: {} }, tools)).toEqual({
      create_skill: 'user-approval',
      delete_tool: 'user-approval',
    })
    expect(createToolApproval('god', { tools: {} }, tools)).toEqual({
      create_skill: 'approved',
      delete_tool: 'approved',
    })
  })
})

describe('createToolApproval for command tools', () => {
  const tools = [{ name: 'run_command' }, { name: 'terminal_kill' }, { name: 'write_file' }]

  it('emits a per-call function only for command tools, so the command itself decides', () => {
    const port = createFakePort()
    const config = createToolApproval('editing', { tools: {} }, tools, { port, threadId: 't1' })
    expect(typeof config.run_command).toBe('function')
    expect(config.terminal_kill).toBe('approved')
    expect(config.write_file).toBe('approved')
  })

  it('denies command tools outright when no bridge scope is available', () => {
    expect(createToolApproval('god', { tools: {} }, tools).run_command).toBe('denied')
  })

  it('the emitted function consults the bridge classifier', async () => {
    const port = createFakePort({ classify: () => ({ sensitive: true, reasons: ['recursive delete'], commands: ['rm'] }) })
    const config = createToolApproval('god', { tools: {} }, tools, { port, threadId: 't1' })
    const decide = config.run_command as (input: unknown, options: { toolCallId: string; messages: unknown[] }) => Promise<unknown>
    expect(await decide({ command: 'rm -rf x' }, { toolCallId: 'c1', messages: [] })).toEqual({
      type: 'user-approval',
      reason: 'Sensitive: recursive delete',
    })
  })
})
