import { stepCountIs, streamText } from 'ai'
import type { LanguageModel, LanguageModelUsage, ToolApprovalConfiguration, ToolSet } from 'ai'
import { createLLM } from '../ai/llm'
import { createTierModel } from '../ai/model-tier'
import type { ModelFactory } from '../ai/model-tier'
import { composeSystemPrompt } from '../chat/context'
import type { SkillRegistry } from '../skills/registry'
import { resolveApprovalStatus } from '../tools/approval'
import type { ToolGateDescriptor } from '../tools/approval'
import type { ToolRegistry } from '../tools/registry'
import type { ToolRuntimePorts } from '../tools/types'
import type { Settings } from '../vault/settings'
import type { AgentApprovalQueue } from './approval-queue'
import { resolveAgentToolNames } from './toolset'
import type { AgentParentContext, AgentRequest, AgentRunEvent, AgentRunResult } from './types'
import { summarizeAgentResult } from './types'

/** Hard bounds so a delegated run cannot loop or flood the parent. */
export const MAX_AGENT_STEPS = 24
export const MAX_AGENT_OUTPUT_CHARS = 8000
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
  maxSteps?: number
  maxOutputChars?: number
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function boundedText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
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
  onEvent: (event: AgentRunEvent) => void,
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
    let toolCalls = 0
    let usage: LanguageModelUsage | undefined
    let failure: string | undefined
    let aborted = false

    try {
      const result = streamText({
        model,
        system,
        prompt: request.prompt,
        tools: toolSet,
        toolApproval,
        stopWhen: stepCountIs(deps.maxSteps ?? MAX_AGENT_STEPS),
        abortSignal: signal,
      })
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            text += part.text
            onEvent({ type: 'text-delta', text: part.text })
            break
          case 'tool-call': {
            toolCalls += 1
            const call = part as { toolName?: string; toolCallId?: string; input?: unknown }
            onEvent({
              type: 'tool-call',
              toolName: call.toolName ?? '',
              toolCallId: call.toolCallId ?? '',
              input: call.input,
            })
            break
          }
          case 'tool-result': {
            const done = part as { toolName?: string; toolCallId?: string }
            onEvent({
              type: 'tool-result',
              toolName: done.toolName ?? '',
              toolCallId: done.toolCallId ?? '',
            })
            break
          }
          case 'tool-error': {
            const failed = part as { toolName?: string; toolCallId?: string; error?: unknown }
            onEvent({
              type: 'tool-error',
              toolName: failed.toolName ?? '',
              toolCallId: failed.toolCallId ?? '',
              error: describe(failed.error),
            })
            break
          }
          case 'finish':
            usage = part.totalUsage
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
    } catch (error) {
      if (signal.aborted || isAbortError(error)) aborted = true
      else failure = describe(error)
    }

    const bounded = boundedText(text, deps.maxOutputChars ?? MAX_AGENT_OUTPUT_CHARS)
    const status: AgentRunResult['status'] = aborted ? 'aborted' : failure ? 'error' : 'completed'
    return {
      ...base,
      status,
      mode,
      text: bounded.text,
      toolCalls,
      ...(usage ? { usage } : {}),
      ...(failure ? { error: failure } : {}),
      ...(bounded.truncated ? { truncated: true } : {}),
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
