import type { UIMessage } from 'ai'

export interface PendingApproval {
  approvalId: string
  toolName: string
  input: unknown
  prompt?: string
}

function toolNameOf(part: Record<string, unknown>): string {
  const type = part.type
  if (typeof type === 'string' && type.startsWith('tool-')) return type.slice('tool-'.length)
  return typeof part.toolName === 'string' ? part.toolName : 'tool'
}

/**
 * True when an approval request carries no user decision to make: the AI SDK
 * emits an `approval-requested` part with `isAutomatic: true` for a statically
 * `approved`/`denied` tool policy, then resolves it in the same stream. Without
 * this guard the prompt flashes and plays its chime for an auto-approved call.
 * A resolution of `expired` is likewise not actionable.
 */
export function isAutomaticApproval(approval: unknown): boolean {
  if (typeof approval !== 'object' || approval === null) return false
  const record = approval as { isAutomatic?: unknown; resolution?: unknown }
  return record.isAutomatic === true || record.resolution === 'expired'
}

/** The most recent pending approval in the thread, if any. */
export function findPendingApproval(messages: readonly UIMessage[]): PendingApproval | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex] as unknown as Record<string, unknown>
      if (part.state !== 'approval-requested') continue
      const approval = part.approval as
        | { id?: unknown; prompt?: unknown; requestReason?: unknown }
        | undefined
      if (!approval || typeof approval.id !== 'string') continue
      if (isAutomaticApproval(approval)) continue
      const prompt =
        typeof approval.prompt === 'string'
          ? approval.prompt
          : typeof approval.requestReason === 'string'
            ? approval.requestReason
            : undefined
      return {
        approvalId: approval.id,
        toolName: toolNameOf(part),
        input: part.input,
        ...(prompt !== undefined ? { prompt } : {}),
      }
    }
  }
  return null
}
