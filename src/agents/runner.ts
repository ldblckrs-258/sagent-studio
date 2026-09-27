import { readUIMessageStream, streamText, toUIMessageStream } from 'ai'
import type {
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  TextStreamPart,
  ToolApprovalConfiguration,
  ToolSet,
  UIMessage,
} from 'ai'
import { createLLM } from '../ai/llm'
import { createTierModel } from '../ai/model-tier'
import type { ModelFactory } from '../ai/model-tier'
import { composeSystemPrompt } from '../chat/context'
import { sanitizePartial } from '../chat/sanitize'
import type { SkillRegistry } from '../skills/registry'
import { resolveApprovalStatus } from '../tools/approval'
import type { ToolGateDescriptor } from '../tools/approval'
import type { ToolRegistry } from '../tools/registry'
import type { ToolRuntimePorts } from '../tools/types'
import type { Settings } from '../vault/settings'
import type { AgentApprovalQueue } from './approval-queue'
import { buildRunMessages, passMessages, promptMessage, toolCallCount } from './run-transcript'
import type { RunPass } from './run-transcript'
import { resolveAgentToolNames } from './toolset'
import type {
  AgentParentContext,
  AgentRequest,
  AgentRunResult,
  AgentSteeringHandle,
} from './types'
import { summarizeAgentResult } from './types'

/**
 * Concurrency is the one hard bound: it protects the machine and the parent
 * conversation, not the delegated task. Step count, steering, and output size
 * are left to the agent and the user; a delegated run is not capped mid-task.
 */
export const MAX_CONCURRENT_AGENTS = 4
export const MAX_AGENTS_PER_THREAD = 3

export interface AgentRunInput {
  runId: string
  request: AgentRequest
  parent: AgentParentContext
}

export interface AgentRunnerDeps {
  settings: Settings | null
  skillRegistry: SkillRegistry
  toolRegistry: ToolRegistry
  /** The ports the delegated tools run against, mirroring the parent's. */
  ports: ToolRuntimePorts
  /** Injectable so tests can hand each model its own mock. */
  modelFactory?: ModelFactory
  queue: AgentApprovalQueue
  /** The live steering channel for this run, when the caller supports it. */
  steering?: AgentSteeringHandle
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

async function* iterate<T>(stream: ReadableStream<T>): AsyncGenerator<T> {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function addTokenCounts(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
}

function addUsage(
  a: LanguageModelUsage | undefined,
  b: LanguageModelUsage | undefined,
): LanguageModelUsage | undefined {
  if (!a) return b
  if (!b) return a
  return {
    inputTokens: addTokenCounts(a.inputTokens, b.inputTokens),
    inputTokenDetails: {
      noCacheTokens: addTokenCounts(a.inputTokenDetails.noCacheTokens, b.inputTokenDetails.noCacheTokens),
      cacheReadTokens: addTokenCounts(a.inputTokenDetails.cacheReadTokens, b.inputTokenDetails.cacheReadTokens),
      cacheWriteTokens: addTokenCounts(a.inputTokenDetails.cacheWriteTokens, b.inputTokenDetails.cacheWriteTokens),
    },
    outputTokens: addTokenCounts(a.outputTokens, b.outputTokens),
    outputTokenDetails: {
      textTokens: addTokenCounts(a.outputTokenDetails.textTokens, b.outputTokenDetails.textTokens),
      reasoningTokens: addTokenCounts(a.outputTokenDetails.reasoningTokens, b.outputTokenDetails.reasoningTokens),
    },
    totalTokens: addTokenCounts(a.totalTokens, b.totalTokens),
  }
}

/**
 * A user turn may only be appended after a tool result or an assistant turn; a
 * trailing tool call would otherwise be split from its result.
 */
function canInject(messages: ModelMessage[]): boolean {
  const last = messages[messages.length - 1]
  return last === undefined || last.role === 'tool' || last.role === 'assistant'
}

/**
 * Runs one delegated agent: clamp the mode, resolve the toolset, stream a
 * bounded step loop, and pause on consent-requiring tools through the approval
 * queue. It never throws into the caller and never leaves a queued approval
 * unsettled.
 */
export async function runAgent(
  input: AgentRunInput,
  deps: AgentRunnerDeps,
  signal: AbortSignal,
  onMessages: (messages: UIMessage[]) => void,
): Promise<AgentRunResult> {
  const { request, parent } = input
  const base: Pick<AgentRunResult, 'tier'> = { tier: request.tier }

  try {
    const resolved = resolveAgentToolNames({
      toolRegistry: deps.toolRegistry,
      skillRegistry: deps.skillRegistry,
      ports: deps.ports,
      parent,
      request,
    })
    if (!resolved.ok) {
      return { ...base, status: 'invalid_input', mode: request.mode, text: '', toolCalls: 0, error: resolved.message }
    }
    const mode = resolved.mode
    const toolSet = deps.toolRegistry.buildToolSet(resolved.names, deps.ports)

    const settings = deps.settings
    const factory: ModelFactory = deps.modelFactory ?? createLLM
    const model: LanguageModel | null = settings
      ? createTierModel(settings, request.tier, factory) ??
        buildParentModel(settings, parent, factory)
      : null
    if (!model) {
      return {
        ...base,
        status: 'error',
        mode,
        text: '',
        toolCalls: 0,
        error: 'No model resolved for the delegated run.',
      }
    }

    const system = composeSystemPrompt(request.prompt, resolved.skills, resolved.names, { mode })
    const descriptorFor = (name: string): ToolGateDescriptor => {
      const kind = deps.toolRegistry.userToolKind(name)
      return kind ? { name, kind } : { name }
    }

    const toolApproval: ToolApprovalConfiguration<ToolSet, unknown> = async ({ toolCall }) => {
      const name = (toolCall as { toolName?: string }).toolName ?? ''
      const toolInput = (toolCall as { input?: unknown }).input
      const status = resolveApprovalStatus(mode, settings?.approvals, descriptorFor(name))
      if (status === 'denied') return 'denied'
      if (status === 'user-approval') {
        const allowed = await deps.queue.request({
          runId: input.runId,
          toolName: name,
          input: toolInput,
        })
        return allowed ? 'approved' : 'denied'
      }
      return 'approved'
    }

    let text = ''
    let usage: LanguageModelUsage | undefined
    let failure: string | undefined
    let aborted = false

    const steering = deps.steering
    const history: ModelMessage[] = [{ role: 'user', content: request.prompt }]
    const injected: ModelMessage[] = []
    const passes: RunPass[] = []
    const opening = promptMessage(input.runId, request.prompt)
    const frozen: UIMessage[] = []
    let settled = false
    const emit = (): void => {
      if (settled) return
      const index = passes.length - 1
      const live = index >= 0 ? passMessages(input.runId, index, passes[index]) : []
      onMessages([opening, ...frozen, ...live])
    }
    const freeze = (pass: RunPass): void => {
      frozen.push(...passMessages(input.runId, passes.indexOf(pass), pass))
    }

    const drainSteering = (): string[] => (steering ? steering.drain() : [])

    try {
      while (true) {
        const pass: RunPass = { assistant: null, steers: [], after: [] }
        passes.push(pass)
        const result = streamText({
          model,
          system,
          messages: history,
          tools: toolSet,
          toolApproval,
          stopWhen: () => false,
          abortSignal: signal,
          prepareStep: ({ messages, stepNumber }) => {
            if (!canInject(messages)) return {}
            const pending = drainSteering()
            if (pending.length === 0) return {}
            for (const message of pending) pass.steers.push({ step: stepNumber, text: message })
            emit()
            const additions = pending.map((content) => ({ role: 'user' as const, content }))
            injected.push(...additions)
            return { messages: [...messages, ...additions] }
          },
        })
        const [accounting, uiSource] = (result.stream as ReadableStream<TextStreamPart<ToolSet>>).tee()
        const uiDone = (async (): Promise<string | undefined> => {
          const chunks = toUIMessageStream({ stream: uiSource, tools: toolSet, onError: describe })
          for await (const partial of readUIMessageStream({ stream: chunks })) {
            pass.assistant = partial
            emit()
          }
          return undefined
        })().catch((error: unknown) => describe(error))
        try {
          for await (const part of iterate(accounting)) {
            switch (part.type) {
              case 'text-delta':
                text += part.text
                break
              case 'finish':
                usage = addUsage(usage, part.totalUsage)
                break
              case 'abort':
                aborted = true
                break
              case 'error':
                failure = describe(part.error)
                break
              default:
                break
            }
          }
        } finally {
          const uiFailure = await uiDone
          if (uiFailure !== undefined && !aborted && !signal.aborted && failure === undefined) {
            failure = uiFailure
          }
        }

        if (aborted || failure) break
        try {
          const { messages } = await result.response
          history.push(...injected, ...messages)
          injected.length = 0
        } catch (error) {
          if (signal.aborted || isAbortError(error)) aborted = true
          else failure = describe(error)
          break
        }
        const pending = drainSteering()
        if (pending.length === 0) break
        for (const message of pending) {
          pass.after.push(message)
          history.push({ role: 'user', content: message })
        }
        freeze(pass)
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) aborted = true
      else failure = describe(error)
    }

    for (const pass of passes) {
      if (pass.assistant) pass.assistant = sanitizePartial(pass.assistant, { expireApprovals: true })
    }
    const transcript = buildRunMessages(input.runId, request.prompt, passes)
    settled = true
    onMessages(transcript)
    const toolCalls = toolCallCount(transcript)

    // The loop above is the only place a steer is delivered. Once past it the run
    // can never drain again, so close the channel and let a late steer be refused
    // rather than accepted into a queue nothing will read.
    steering?.close?.()

    const stopped = aborted && (steering?.stopRequested() ?? false)
    const stopReason = stopped ? steering?.stopReason() ?? 'user_stop' : undefined
    let status: AgentRunResult['status'] = 'completed'
    if (aborted) status = stopped ? 'stopped' : 'aborted'
    else if (failure) status = 'error'
    return {
      ...base,
      status,
      mode,
      text,
      toolCalls,
      ...(usage ? { usage } : {}),
      ...(failure ? { error: failure } : {}),
      ...(stopReason ? { stopReason } : {}),
    }
  } catch (error) {
    return {
      ...base,
      status: 'error',
      mode: request.mode,
      text: '',
      toolCalls: 0,
      error: describe(error),
    }
  }
}

function buildParentModel(
  settings: Settings,
  parent: AgentParentContext,
  factory: ModelFactory,
): LanguageModel | null {
  try {
    return factory(settings, parent.providerId, parent.modelId)
  } catch {
    return null
  }
}

export { summarizeAgentResult }
