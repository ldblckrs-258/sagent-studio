import { convertToModelMessages, jsonSchema, readUIMessageStream, streamText, tool, toUIMessageStream } from 'ai'
import type { ToolSet, UIMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'

type Usage = {
  inputTokens: { total: number; noCache: number; cacheRead: number; cacheWrite: number }
  outputTokens: { total: number; text: number; reasoning: number }
}

type Chunk =
  | { type: 'stream-start'; warnings: never[] }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'tool-input-start'; id: string; toolName: string }
  | { type: 'tool-input-delta'; id: string; delta: string }
  | { type: 'tool-input-end'; id: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
  | { type: 'finish'; usage: Usage; finishReason: { unified: 'stop' | 'tool-calls'; raw: string | undefined } }

function usage(): Usage {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  }
}

function streamOf(chunks: Chunk[]): ReadableStream<Chunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

function textStep(id: string, delta: string): Chunk[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id },
    { type: 'text-delta', id, delta },
    { type: 'text-end', id },
    { type: 'finish', usage: usage(), finishReason: { unified: 'stop', raw: undefined } },
  ]
}

function toolStep(id: string, toolName: string, input: string): Chunk[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id, toolName },
    { type: 'tool-input-delta', id, delta: input },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName, input },
    { type: 'finish', usage: usage(), finishReason: { unified: 'tool-calls', raw: 'tool_calls' } },
  ]
}

function toolsWith(execute: (input: unknown) => Promise<string>): ToolSet {
  return {
    write_file: tool({
      description: 'Write a file.',
      inputSchema: jsonSchema<{ path: string }>({
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      } as Parameters<typeof jsonSchema>[0]),
      execute: async (input) => execute(input),
    }),
  }
}

const userMessage: UIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'go' }] }

async function readAssistant(stream: ReturnType<typeof toUIMessageStream>): Promise<UIMessage> {
  let latest: UIMessage | undefined
  for await (const message of readUIMessageStream({ stream })) latest = message
  if (!latest) throw new Error('no assistant message')
  return latest
}

describe('approval round-trip (spike)', () => {
  it('requests approval without executing, then executes once after approval', async () => {
    let executions = 0
    const model = new MockLanguageModelV4({
      doStream: [
        { stream: streamOf(toolStep('c1', 'write_file', '{"path":"a.txt"}')) },
        { stream: streamOf(textStep('t2', 'done')) },
      ],
    })
    const tools = toolsWith(async () => {
      executions += 1
      return 'written'
    })

    const first = streamText({
      model,
      messages: await convertToModelMessages([userMessage], { tools }),
      tools,
      toolApproval: { write_file: 'user-approval' },
      stopWhen: () => false,
    })
    const firstName = await readAssistant(
      toUIMessageStream({
        stream: first.stream,
        tools,
        originalMessages: [userMessage],
        generateMessageId: () => 'a1',
      }),
    )
    expect(executions).toBe(0)
    const requested = firstName.parts.find((part) => part.type === 'tool-write_file')
    expect(requested).toMatchObject({ state: 'approval-requested' })
    const approvalId = (requested as { approval?: { id?: string } }).approval?.id
    expect(typeof approvalId).toBe('string')
    expect(approvalId?.length).toBeGreaterThan(0)

    const responded: UIMessage = {
      ...firstName,
      parts: firstName.parts.map((part) =>
        part.type === 'tool-write_file' && part.state === 'approval-requested'
          ? ({ ...part, state: 'approval-responded', approval: { ...part.approval, approved: true } } as UIMessage['parts'][number])
          : part,
      ),
    }
    const converted = await convertToModelMessages([userMessage, responded], {
      tools,
      ignoreIncompleteToolCalls: true,
    })
    expect(JSON.stringify(converted)).toContain('tool-approval-response')

    const second = streamText({ model, messages: converted, tools, stopWhen: () => false })
    await expect(second.text).resolves.toBe('done')
    expect(executions).toBe(1)
  })

  it('drops a still-pending approval-requested part under ignoreIncompleteToolCalls', async () => {
    const tools = toolsWith(async () => 'written')
    const pending: UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-write_file',
          toolCallId: 'c1',
          state: 'approval-requested',
          input: { path: 'a.txt' },
          approval: { id: 'ap1' },
        },
      ],
    }
    const converted = await convertToModelMessages([userMessage, pending], {
      tools,
      ignoreIncompleteToolCalls: true,
    })
    expect(JSON.stringify(converted)).not.toContain('write_file')
  })

  it('never executes on denial and emits an execution-denied result', async () => {
    let executions = 0
    const tools = toolsWith(async () => {
      executions += 1
      return 'written'
    })
    const denied: UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-write_file',
          toolCallId: 'c1',
          state: 'approval-responded',
          input: { path: 'a.txt' },
          approval: { id: 'ap1', approved: false, reason: 'not now' },
        },
      ],
    }
    const converted = await convertToModelMessages([userMessage, denied], {
      tools,
      ignoreIncompleteToolCalls: true,
    })
    expect(executions).toBe(0)
    expect(JSON.stringify(converted)).toContain('execution-denied')
  })

  it('does not execute on an allow policy without an approval request', async () => {
    let executions = 0
    const model = new MockLanguageModelV4({
      doStream: [
        { stream: streamOf(toolStep('c1', 'write_file', '{"path":"a.txt"}')) },
        { stream: streamOf(textStep('t2', 'done')) },
      ],
    })
    const tools = toolsWith(async () => {
      executions += 1
      return 'written'
    })
    const result = streamText({
      model,
      messages: await convertToModelMessages([userMessage], { tools }),
      tools,
      toolApproval: { write_file: 'approved' },
      stopWhen: () => false,
    })
    await expect(result.text).resolves.toBe('done')
    expect(executions).toBe(1)
  })
})
