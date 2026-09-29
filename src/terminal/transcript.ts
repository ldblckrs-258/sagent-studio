import type { UIMessage } from 'ai'
import { COMMAND_TOOLS } from '../tools/approval'
import { describeCommandInput } from './approval'

export function commandsInMessages(messages: readonly UIMessage[]): string[] {
  const commands: string[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (!part.type.startsWith('tool-')) continue
      const name = part.type.slice('tool-'.length)
      if (!COMMAND_TOOLS.has(name)) continue
      const described = describeCommandInput(name, (part as { input?: unknown }).input)
      if (described) commands.push(described)
    }
  }
  return commands
}

export function commandsFromMessage(messages: readonly UIMessage[], messageId: string): string[] {
  const index = messages.findIndex((message) => message.id === messageId)
  return index < 0 ? [] : commandsInMessages(messages.slice(index))
}
