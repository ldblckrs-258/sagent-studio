import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { findPendingApproval, isAutomaticApproval } from './approval-pending'

function assistant(parts: unknown[]): UIMessage {
  return { id: 'a1', role: 'assistant', parts: parts as UIMessage['parts'] }
}

function pendingPart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'tool-write_file',
    toolCallId: 'c1',
    state: 'approval-requested',
    input: { path: 'a.txt' },
    approval: { id: 'ap1' },
    ...overrides,
  }
}

describe('findPendingApproval', () => {
  it('returns null when there is no pending approval', () => {
    expect(findPendingApproval([])).toBeNull()
    expect(findPendingApproval([assistant([{ type: 'text', text: 'hi' }])])).toBeNull()
  })

  it('returns the tool name, input, and approval id of the newest pending part', () => {
    expect(findPendingApproval([assistant([pendingPart()])])).toEqual({
      approvalId: 'ap1',
      toolName: 'write_file',
      input: { path: 'a.txt' },
    })
  })

  it('prefers the newest pending approval in the last assistant message', () => {
    const older = assistant([pendingPart({ approval: { id: 'old' } })])
    const newer = assistant([
      pendingPart({ type: 'tool-remove', approval: { id: 'new' }, input: { path: 'b.txt' } }),
    ])
    expect(findPendingApproval([older, newer])?.approvalId).toBe('new')
    expect(findPendingApproval([older, newer])?.toolName).toBe('remove')
  })

  it('ignores an approval that is not pending', () => {
    expect(
      findPendingApproval([
        assistant([pendingPart({ state: 'approval-responded', approval: { id: 'ap1', approved: true } })]),
      ]),
    ).toBeNull()
  })

  it('surfaces a request reason as the prompt', () => {
    expect(
      findPendingApproval([
        assistant([pendingPart({ approval: { id: 'ap1', requestReason: 'writes a file' } })]),
      ])?.prompt,
    ).toBe('writes a file')
  })

  it('reads a dynamic tool name', () => {
    expect(
      findPendingApproval([
        assistant([pendingPart({ type: 'dynamic-tool', toolName: 'custom' })]),
      ])?.toolName,
    ).toBe('custom')
  })

  it('ignores an automatic approval so an auto-approved tool never prompts', () => {
    expect(isAutomaticApproval({ id: 'ap1', isAutomatic: true })).toBe(true)
    expect(
      findPendingApproval([
        assistant([pendingPart({ approval: { id: 'ap1', isAutomatic: true } })]),
      ]),
    ).toBeNull()
  })

  it('ignores an expired approval', () => {
    expect(
      findPendingApproval([
        assistant([pendingPart({ approval: { id: 'ap1', resolution: 'expired' } })]),
      ]),
    ).toBeNull()
  })

  it('still finds a real pending approval next to an automatic one', () => {
    const message = assistant([
      pendingPart({ approval: { id: 'auto', isAutomatic: true } }),
      pendingPart({ type: 'tool-remove', approval: { id: 'real' }, input: { path: 'b.txt' } }),
    ])
    expect(findPendingApproval([message])?.approvalId).toBe('real')
  })
})
