import { describe, expect, it } from 'vitest'
import { jsonSchema, stepCountIs, streamText, tool } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'

type Usage = {
  inputTokens: {
    total: number | undefined
    noCache: number | undefined
    cacheRead: number | undefined
    cacheWrite: number | undefined
  }
  outputTokens: {
    total: number | undefined
    text: number | undefined
    reasoning: number | undefined
  }
}

type FinishReason = { unified: 'stop' | 'tool-calls'; raw: string | undefined }

type Chunk =
  | { type: 'stream-start'; warnings: never[] }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'tool-input-start'; id: string; toolName: string }
  | { type: 'tool-input-delta'; id: string; delta: string }
  | { type: 'tool-input-end'; id: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
  | { type: 'finish'; usage: Usage; finishReason: FinishReason }

function usage(): Usage {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  }
}

function streamFrom(chunks: Chunk[]): ReadableStream<Chunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
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

function textStep(id: string, delta: string): Chunk[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id },
    { type: 'text-delta', id, delta },
    { type: 'text-end', id },
    { type: 'finish', usage: usage(), finishReason: { unified: 'stop', raw: undefined } },
  ]
}

describe('streamText seam', () => {
  it('executes a tool step then a text step and forwards top-level params', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        { stream: streamFrom(toolStep('call-1', 'echo', '{"value":"x"}')) },
        { stream: streamFrom(textStep('t2', 'done')) },
      ],
    })

    let executed: unknown
    const result = streamText({
      model,
      prompt: 'use the tool',
      temperature: 0.4,
      stopWhen: stepCountIs(2),
      tools: {
        echo: tool({
          description: 'Echo a value back.',
          inputSchema: jsonSchema<{ value: string }>({
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          }),
          execute: async (input) => {
            executed = input
            return `echo:${input.value}`
          },
        }),
      },
    })

    await expect(result.text).resolves.toBe('done')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(model.doStreamCalls[0].temperature).toBe(0.4)
    expect(executed).toEqual({ value: 'x' })
  })
})
