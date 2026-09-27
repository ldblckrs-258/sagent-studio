import type { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import { buildRunMessages, repairLegacyRunMessages } from './run-transcript'

type Part = UIMessage['parts'][number]

function assistant(parts: unknown[]): UIMessage {
  return { id: 'x', role: 'assistant', parts: parts as Part[] }
}

const listDir = {
  type: 'tool-list_dir',
  toolCallId: 'c1',
  state: 'output-available',
  input: {},
  output: { ok: true, code: 'ok', value: { entries: [{ path: 'a.ts' }] } },
}

describe('buildRunMessages', () => {
  it('opens with the prompt and keeps the assistant parts of a pass intact', () => {
    const messages = buildRunMessages('r', 'map it', [
      { assistant: assistant([{ type: 'step-start' }, listDir]), steers: [], after: [] },
    ])

    expect(messages.map((message) => message.id)).toEqual(['r-prompt', 'r-a0-0'])
    expect(messages[1].parts[1]).toEqual(listDir)
  })

  it('cuts a pass at the step a steer was injected before, so the steer reads in order', () => {
    const parts = [
      { type: 'step-start' },
      listDir,
      { type: 'step-start' },
      { type: 'text', text: 'after the steer' },
    ]
    const messages = buildRunMessages('r', 'go', [
      { assistant: assistant(parts), steers: [{ step: 1, text: 'focus on tests' }], after: [] },
    ])

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(messages[1].parts).toEqual([{ type: 'step-start' }, listDir])
    expect(messages[2].parts).toEqual([{ type: 'text', text: 'focus on tests' }])
    expect(messages[3].parts.at(-1)).toEqual({ type: 'text', text: 'after the steer' })
  })

  it('places a steer whose step has not streamed yet after everything shown so far', () => {
    const messages = buildRunMessages('r', 'go', [
      { assistant: assistant([{ type: 'step-start' }, listDir]), steers: [{ step: 1, text: 'next' }], after: [] },
    ])

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('appends steers that started the next pass between the passes', () => {
    const messages = buildRunMessages('r', 'go', [
      { assistant: assistant([{ type: 'text', text: 'one' }]), steers: [], after: ['again'] },
      { assistant: assistant([{ type: 'text', text: 'two' }]), steers: [], after: [] },
    ])

    expect(messages.map((message) => message.id)).toEqual(['r-prompt', 'r-a0-0', 'r-u0-0', 'r-a1-0'])
  })

  it('skips an assistant segment that holds only step boundaries', () => {
    const messages = buildRunMessages('r', 'go', [
      { assistant: assistant([{ type: 'step-start' }]), steers: [], after: [] },
    ])

    expect(messages).toHaveLength(1)
  })
})

describe('repairLegacyRunMessages', () => {
  it('reads a lost result as not recorded instead of an empty success', () => {
    const [message] = repairLegacyRunMessages([
      assistant([{ type: 'dynamic-tool', toolName: 'list_dir', toolCallId: 'c1', state: 'output-available', input: {}, output: {} }]),
    ])

    expect(message.parts[0]).toMatchObject({ state: 'output-error', errorText: 'The result of this call was not recorded.' })
    expect(message.parts[0]).not.toHaveProperty('output')
  })

  it('keeps a recorded result and coalesces per-delta text parts', () => {
    const [message] = repairLegacyRunMessages([
      assistant([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, listDir]),
    ])

    expect(message.parts).toEqual([{ type: 'text', text: 'ab' }, listDir])
  })
})
