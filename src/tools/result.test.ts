import { describe, expect, it } from 'vitest'
import { SandboxTimeoutError } from '../sandbox/protocol'
import {
  WorkspaceLimitError,
  WorkspaceNotFoundError,
  WorkspacePathError,
  WorkspacePermissionError,
} from '../workspace/errors'
import {
  HttpToolError,
  ToolRuntimeUnavailableError,
  ToolSchemaError,
} from './types'
import { ToolResultError, toToolResult, toolFail, toolOk, wrapToolExecute } from './result'

describe('toolOk', () => {
  it('produces a success envelope with no message', () => {
    expect(toolOk({ total: 3 })).toEqual({ ok: true, code: 'ok', value: { total: 3 } })
  })

  it('carries truncated when requested', () => {
    expect(toolOk([1], { truncated: true })).toEqual({
      ok: true,
      code: 'ok',
      value: [1],
      truncated: true,
    })
  })
})

describe('toolFail', () => {
  it('produces a failure envelope with code, message, and hint', () => {
    expect(toolFail('no_match', 'Nothing matched.', { hint: 'Check the string.' })).toEqual({
      ok: false,
      code: 'no_match',
      message: 'Nothing matched.',
      hint: 'Check the string.',
    })
  })
})

describe('toToolResult', () => {
  it('maps each recognized error name to its code', () => {
    const cases: Array<[unknown, string]> = [
      [new WorkspacePathError('../x'), 'path_rejected'],
      [new WorkspacePermissionError(), 'permission_denied'],
      [new WorkspaceNotFoundError('a.txt'), 'not_found'],
      [new WorkspaceLimitError('big.txt'), 'limit_exceeded'],
      [new HttpToolError(), 'http_error'],
      [new ToolSchemaError(), 'invalid_input'],
      [new SandboxTimeoutError(), 'timeout'],
    ]
    for (const [error, code] of cases) {
      const result = toToolResult(error)
      expect(result.ok, code).toBe(false)
      expect(result.code, code).toBe(code)
      expect(typeof result.message, code).toBe('string')
    }
  })

  it('preserves a hint supplied by context', () => {
    const result = toToolResult(new WorkspacePathError('../x'), { hint: 'Stay in the workspace.' })
    expect(result).toMatchObject({ ok: false, code: 'path_rejected', hint: 'Stay in the workspace.' })
  })

  it('maps a ToolResultError to its own code, hint, and value', () => {
    const result = toToolResult(new ToolResultError('conflict', 'Already exists.', { hint: 'Use another name.' }))
    expect(result).toEqual({
      ok: false,
      code: 'conflict',
      message: 'Already exists.',
      hint: 'Use another name.',
    })
  })

  it('rethrows a runtime-unavailable error', () => {
    expect(() => toToolResult(new ToolRuntimeUnavailableError('read_file'))).toThrow(
      ToolRuntimeUnavailableError,
    )
  })

  it('converts an arbitrary error to a runtime_error envelope', () => {
    expect(toToolResult(new Error('boom'))).toEqual({
      ok: false,
      code: 'runtime_error',
      message: 'boom',
    })
  })

  it('converts an unrecognized DOMException to a runtime_error envelope', () => {
    const result = toToolResult(new DOMException('weird', 'QuotaExceededError'))
    expect(result).toMatchObject({ ok: false, code: 'runtime_error' })
  })
})

describe('wrapToolExecute', () => {
  it('wraps a successful value in a success envelope', async () => {
    const wrapped = wrapToolExecute(async (input: { n: number }) => input.n * 2)
    await expect(wrapped({ n: 2 })).resolves.toEqual({ ok: true, code: 'ok', value: 4 })
  })

  it('passes through an explicit envelope', async () => {
    const wrapped = wrapToolExecute(async () => toolFail('denied', 'No.'))
    await expect(wrapped()).resolves.toMatchObject({ ok: false, code: 'denied' })
  })

  it('converts a recognized error to a failure envelope', async () => {
    const wrapped = wrapToolExecute(async () => {
      throw new WorkspacePathError('../x')
    })
    await expect(wrapped()).resolves.toMatchObject({ ok: false, code: 'path_rejected' })
  })

  it('converts an unrecognized error to a runtime_error envelope', async () => {
    const wrapped = wrapToolExecute(async () => {
      throw new Error('boom')
    })
    await expect(wrapped()).resolves.toMatchObject({ ok: false, code: 'runtime_error' })
  })

  it('rethrows only a runtime-unavailable error', async () => {
    const wrapped = wrapToolExecute(async () => {
      throw new ToolRuntimeUnavailableError('tool')
    })
    await expect(wrapped()).rejects.toBeInstanceOf(ToolRuntimeUnavailableError)
  })
})
