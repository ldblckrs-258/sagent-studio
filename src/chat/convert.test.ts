import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { extractText, toThreadMessageLike, toUiParts } from './convert'
import type { IncomingContent } from './convert'

function message(role: UIMessage['role'], parts: unknown[]): UIMessage {
  return { id: `${role}-1`, role, parts: parts as UIMessage['parts'] }
}

function partsOf(value: unknown): Record<string, unknown>[] {
  return toThreadMessageLike(value as UIMessage, 0).content as unknown as Record<string, unknown>[]
}

describe('toThreadMessageLike', () => {
  it('maps a text part', () => {
    const like = toThreadMessageLike(message('assistant', [{ type: 'text', text: 'hello' }]), 0)
    expect(like.role).toBe('assistant')
    expect(like.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(like.status).toBeUndefined()
  })

  it('maps a reasoning part', () => {
    expect(partsOf(message('assistant', [{ type: 'reasoning', text: 'thinking' }]))).toEqual([
      { type: 'reasoning', text: 'thinking' },
    ])
  })

  it('maps a named tool part with an available output', () => {
    const part = {
      type: 'tool-weather',
      toolCallId: 'c1',
      state: 'output-available',
      input: { city: 'Paris' },
      output: { temp: 20 },
    }
    expect(partsOf(message('assistant', [part]))).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'weather',
        args: { city: 'Paris' },
        argsText: '{"city":"Paris"}',
        result: { temp: 20 },
        isError: false,
      },
    ])
  })

  it('maps a dynamic tool part', () => {
    const part = {
      type: 'dynamic-tool',
      toolName: 'search',
      toolCallId: 'c2',
      state: 'output-available',
      input: { q: 'x' },
      output: 'found',
    }
    expect(partsOf(message('assistant', [part]))).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'c2',
        toolName: 'search',
        args: { q: 'x' },
        argsText: '{"q":"x"}',
        result: 'found',
        isError: false,
      },
    ])
  })

  it('marks a failure envelope result as an error part', () => {
    const part = {
      type: 'tool-read_file',
      toolCallId: 'ce1',
      state: 'output-available',
      input: { path: '../x' },
      output: { ok: false, code: 'path_rejected', message: 'nope' },
    }
    expect(partsOf(message('assistant', [part]))).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'ce1',
        toolName: 'read_file',
        args: { path: '../x' },
        argsText: '{"path":"../x"}',
        result: { ok: false, code: 'path_rejected', message: 'nope' },
        isError: true,
      },
    ])
  })

  it('leaves a success envelope result as a non-error part', () => {
    const part = {
      type: 'tool-read_file',
      toolCallId: 'ce2',
      state: 'output-available',
      input: { path: 'a.txt' },
      output: { ok: true, code: 'ok', value: { path: 'a.txt', content: 'hi' } },
    }
    expect(partsOf(message('assistant', [part]))).toMatchObject([{ isError: false }])
  })

  it('maps an input-streaming tool with partial input', () => {
    const part = {
      type: 'tool-weather',
      toolCallId: 'c3',
      state: 'input-streaming',
      input: { city: 'Par' },
    }
    expect(partsOf(message('assistant', [part]))).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'c3',
        toolName: 'weather',
        args: { city: 'Par' },
        argsText: '{"city":"Par"}',
      },
    ])
  })

  it('maps a tool output error to an error result', () => {
    const part = {
      type: 'tool-weather',
      toolCallId: 'c4',
      state: 'output-error',
      input: {},
      errorText: 'boom',
    }
    expect(partsOf(message('assistant', [part]))).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'c4',
        toolName: 'weather',
        args: {},
        argsText: '{}',
        result: 'boom',
        isError: true,
      },
    ])
  })

  it('maps an approval-requested part with synthesized options and no result', () => {
    const part = {
      type: 'tool-write_file',
      toolCallId: 'c5',
      state: 'approval-requested',
      input: { path: 'a.txt' },
      approval: { id: 'ap1' },
    }
    const result = partsOf(message('assistant', [part]))[0] as Record<string, unknown>
    expect(result.state).toBeUndefined()
    expect(result.isError).toBeUndefined()
    expect(result.result).toBeUndefined()
    expect(result.approval).toEqual({
      id: 'ap1',
      options: [
        { id: 'allow-once', kind: 'allow-once' },
        { id: 'allow-always', kind: 'allow-always' },
      ],
    })
  })

  it('maps an approval-responded part carrying the decision', () => {
    const part = {
      type: 'tool-write_file',
      toolCallId: 'c6',
      state: 'approval-responded',
      input: { path: 'a.txt' },
      approval: { id: 'ap1', approved: true },
    }
    const result = partsOf(message('assistant', [part]))[0] as Record<string, unknown>
    expect(result.approval).toEqual({ id: 'ap1', approved: true })
    expect(result.result).toBeUndefined()
  })

  it('uses the approval reason for an output-denied part', () => {
    const part = {
      type: 'tool-write_file',
      toolCallId: 'c7',
      state: 'output-denied',
      input: { path: 'a.txt' },
      approval: { id: 'ap1', approved: false, reason: 'not now' },
    }
    expect(partsOf(message('assistant', [part]))[0]).toMatchObject({
      result: 'not now',
      isError: true,
    })
  })

  it('maps a data part by its prefixed type', () => {
    expect(partsOf(message('assistant', [{ type: 'data-chart', data: { a: 1 } }]))).toEqual([
      { type: 'data-chart', data: { a: 1 } },
    ])
  })

  it('renames file part fields', () => {
    const part = { type: 'file', url: 'blob:x', mediaType: 'text/plain', filename: 'a.txt' }
    expect(partsOf(message('user', [part]))).toEqual([
      { type: 'file', data: 'blob:x', mimeType: 'text/plain', filename: 'a.txt' },
    ])
  })

  it('drops step-start and blank text parts', () => {
    const parts = [
      { type: 'step-start' },
      { type: 'text', text: '   ' },
      { type: 'text', text: 'kept' },
    ]
    expect(partsOf(message('assistant', parts))).toEqual([{ type: 'text', text: 'kept' }])
  })

  it('drops assistant-only parts from a user message', () => {
    const parts = [
      { type: 'text', text: 'hi' },
      { type: 'reasoning', text: 'hidden' },
      { type: 'tool-weather', toolCallId: 'c1', state: 'output-available', input: {}, output: {} },
    ]
    expect(partsOf(message('user', parts))).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('omits status on a normal assistant message and on every non-assistant message', () => {
    expect(toThreadMessageLike(message('assistant', [{ type: 'text', text: 'x' }]), 0).status).toBeUndefined()
    expect(toThreadMessageLike(message('user', [{ type: 'text', text: 'x' }]), 0).status).toBeUndefined()
  })

  it('emits a terminal error status only for an assistant error marker', () => {
    const errored: UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'x' }],
      metadata: { error: 'provider failed' },
    }
    expect(toThreadMessageLike(errored, 0).status).toEqual({
      type: 'incomplete',
      reason: 'error',
      error: 'provider failed',
    })

    const userErrored: UIMessage = {
      id: 'u1',
      role: 'user',
      parts: [{ type: 'text', text: 'x' }],
      metadata: { error: 'provider failed' },
    }
    expect(toThreadMessageLike(userErrored, 0).status).toBeUndefined()
  })
})

describe('toUiParts', () => {
  it('round-trips a text message', () => {
    const original = message('user', [{ type: 'text', text: 'hello' }])
    const content = toThreadMessageLike(original, 0).content as IncomingContent
    expect(toUiParts(content)).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('maps a completed tool-call back to a tool part', () => {
    const content: IncomingContent = [
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'weather',
        args: { city: 'Paris' },
        result: { temp: 20 },
      },
    ]
    expect(toUiParts(content)).toEqual([
      {
        type: 'tool-weather',
        toolCallId: 'c1',
        state: 'output-available',
        input: { city: 'Paris' },
        output: { temp: 20 },
      },
    ])
  })

  it('round-trips an approval part back to the paused state', () => {
    const content: IncomingContent = [
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'write_file',
        args: { path: 'a.txt' },
        approval: { id: 'ap1', options: [{ id: 'allow-once', kind: 'allow-once' }] },
      },
    ]
    expect(toUiParts(content)).toEqual([
      {
        type: 'tool-write_file',
        toolCallId: 'c1',
        state: 'approval-requested',
        input: { path: 'a.txt' },
        approval: { id: 'ap1', options: [{ id: 'allow-once', kind: 'allow-once' }] },
      },
    ])
  })

  it('round-trips an answered approval as approval-responded', () => {
    const content: IncomingContent = [
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'write_file',
        args: {},
        approval: { id: 'ap1', approved: true },
      },
    ]
    expect(toUiParts(content)).toEqual([
      {
        type: 'tool-write_file',
        toolCallId: 'c1',
        state: 'approval-responded',
        input: {},
        approval: { id: 'ap1', approved: true },
      },
    ])
  })

  it('maps an errored tool-call to an output-error tool part', () => {
    const content: IncomingContent = [
      { type: 'tool-call', toolCallId: 'c1', toolName: 'weather', args: {}, result: 'boom', isError: true },
    ]
    expect(toUiParts(content)).toEqual([
      {
        type: 'tool-weather',
        toolCallId: 'c1',
        state: 'output-error',
        input: {},
        output: 'boom',
        errorText: 'boom',
      },
    ])
  })
})

describe('extractText', () => {
  it('joins non-empty text parts and ignores reasoning', () => {
    const content: IncomingContent = [
      { type: 'reasoning', text: 'ignored' },
      { type: 'text', text: 'one' },
      { type: 'text', text: '' },
      { type: 'tool-call', toolName: 'x' },
      { type: 'text', text: 'two' },
    ]
    expect(extractText(content)).toBe('one\ntwo')
  })

  it('returns an empty string when there is no text', () => {
    expect(extractText([{ type: 'reasoning', text: 'x' }])).toBe('')
  })
})

describe('attachment parts in the transcript', () => {
  it('keeps a file body out of the user bubble and badges it instead', () => {
    const message: UIMessage = {
      id: 'u1',
      role: 'user',
      parts: [
        {
          type: 'text',
          text: 'Attached workspace content follows. A block opened with id="abc"…',
        },
        { type: 'text', text: '<attached id="abc" path="a.ts" bytes=12>\nconst a = 1\n</attached-abc>' },
        { type: 'text', text: '<attached-ref path="docs" mode="reference" />' },
        { type: 'text', text: 'what does this do?' },
      ],
      metadata: {
        attachments: [
          { path: 'a.ts', hash: 'cafe', mode: 'inline' },
          { path: 'docs', hash: '', mode: 'reference' },
        ],
      },
    } as UIMessage

    const like = toThreadMessageLike(message, 0)
    // Only the question is the user's own words; the rest is repository bytes
    // the model needs and a reader does not.
    expect(like.content).toEqual([{ type: 'text', text: 'what does this do?' }])
    expect(
      (like.metadata?.custom as { attachments?: unknown[] } | undefined)?.attachments,
    ).toHaveLength(2)
  })

  it('leaves a message that merely mentions the word alone', () => {
    const message: UIMessage = {
      id: 'u2',
      role: 'user',
      parts: [{ type: 'text', text: 'the attached file is wrong' }],
    } as UIMessage
    expect(toThreadMessageLike(message, 0).content).toHaveLength(1)
  })

  it('carries a background agent report onto the thread message', () => {
    const message: UIMessage = {
      id: 'n1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Sub-agent "audit" finished: done' }],
      metadata: {
        chatStatus: 'done',
        agentNotice: true,
        untrusted: true,
        runId: 'run-3',
        agentReport: { runId: 'run-3', label: 'audit', status: 'completed', response: 'done' },
      },
    } as UIMessage

    const like = toThreadMessageLike(message, 0)
    expect(
      (like.metadata?.custom as { agentReport?: { label?: string } } | undefined)?.agentReport,
    ).toMatchObject({ label: 'audit', status: 'completed', response: 'done' })
  })
})
