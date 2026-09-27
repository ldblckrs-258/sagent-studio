import type { ModelMessage } from 'ai'
import { estimateTokens } from '../chat/usage'

const KEPT_EXCHANGES = 2

export function safeCutIndex(messages: readonly ModelMessage[]): number {
  let seen = 0
  let limit = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== 'assistant') continue
    seen += 1
    if (seen === KEPT_EXCHANGES) {
      limit = index
      break
    }
  }
  for (let index = limit; index >= 1; index -= 1) {
    const role = messages[index].role
    if (role === 'user' || (role !== 'tool' && messages[index - 1].role === 'tool')) return index
  }
  return 0
}

export function compactPrefix(
  messages: readonly ModelMessage[],
  summary: string,
  cut: number,
  task?: string,
): ModelMessage[] {
  const sections = [
    ...(task !== undefined && task.trim().length > 0
      ? [`<original-task>\n${task.trim()}\n</original-task>`]
      : []),
    `<earlier-work-summary>\n${summary}\n</earlier-work-summary>`,
  ]
  return [{ role: 'user', content: sections.join('\n\n') }, ...messages.slice(cut)]
}

export function estimateModelMessagesTokens(messages: readonly ModelMessage[]): number {
  return estimateTokens(JSON.stringify(messages))
}
