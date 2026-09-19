import type { UIMessage } from 'ai'

function indexOf(messages: UIMessage[], id: string): number {
  return messages.findIndex((message) => message.id === id)
}

export function appendMessage(messages: UIMessage[], message: UIMessage): UIMessage[] {
  return [...messages, message]
}

export function editMessage(
  messages: UIMessage[],
  id: string,
  parts: UIMessage['parts'],
): UIMessage[] {
  const index = indexOf(messages, id)
  if (index === -1) return messages
  return [...messages.slice(0, index), { ...messages[index], parts }]
}

export function deleteMessage(messages: UIMessage[], id: string): UIMessage[] {
  const index = indexOf(messages, id)
  if (index === -1) return messages
  return [...messages.slice(0, index), ...messages.slice(index + 1)]
}

export function truncateAfter(messages: UIMessage[], id: string): UIMessage[] {
  const index = indexOf(messages, id)
  if (index === -1) return messages
  return messages.slice(0, index + 1)
}

export function undoLastTurn(messages: UIMessage[]): UIMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return messages.slice(0, index)
  }
  return messages
}

export function baseForMessage(messages: UIMessage[], id: string): UIMessage[] {
  const index = indexOf(messages, id)
  if (index === -1) return messages
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (messages[cursor].role === 'user') return messages.slice(0, cursor + 1)
  }
  return []
}

export function canUndo(messages: UIMessage[]): boolean {
  return messages.some((message) => message.role === 'user')
}

export function canRerun(messages: UIMessage[], id: string): boolean {
  const index = indexOf(messages, id)
  if (index === -1) return false
  if (messages[index].role !== 'assistant') return false
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor].role === 'user') return true
  }
  return false
}
