import { generateId } from 'ai'
import type { UIMessage } from 'ai'
import { skillKey } from '../skills/schema'
import { VaultLockedError } from '../vault/errors'
import { ChatError } from './errors'
import type { ChatMessageMetadata } from './sanitize'
import type { SlashContext } from './slash'
import { useChatStore } from './store'
import { patchThreadConfig } from './threads'
import type { SkillRef } from './types'

/** Identifies a directive message so the UI renders a marker, not a bubble. */
export type SkillDirective = {
  id: string
  source: 'vault' | 'workspace'
  name: string
}

/**
 * Names the tool and the target and nothing else. Sending the skill's body here
 * would put the whole instruction set in the conversation on every turn from
 * now on; a two-line directive costs a handful of tokens, and the body enters
 * context only if the model actually loads it, through the same tool path that
 * already handles trusted and untrusted sources.
 */
export function skillDirectiveMessage(skill: SkillDirective): UIMessage {
  const metadata: ChatMessageMetadata = { chatStatus: 'done', skillDirective: skill }
  return {
    id: generateId(),
    role: 'user',
    parts: [
      {
        type: 'text',
        text: `Call \`load_skill\` with id \`${skill.id}\` and source \`${skill.source}\` now, then follow the returned instructions for this task.`,
      },
    ],
    metadata,
  }
}

function hasRef(refs: readonly SkillRef[], ref: SkillRef): boolean {
  const key = skillKey(ref)
  return refs.some((entry) => skillKey(entry) === key)
}

/**
 * Enables the skill on the thread, then appends the directive.
 *
 * Enabling is not optional. `buildRunStream` resolves the skill port from
 * `config.enabledSkills`, and `load_skill` only joins the tool set when that
 * list is non-empty, so a directive without enablement would resolve to null.
 * Enabling also applies the skill's `allowedTools` narrowing, which is the
 * existing meaning of enabling a skill rather than a new side effect.
 */
export async function invokeSkill(
  ctx: SlashContext,
  ref: SkillRef,
  trailingText: string,
): Promise<void> {
  const manifest = ctx.session.skillRegistry.get(ref)
  if (!manifest) {
    throw new ChatError(`No skill "${ref.id}" is installed from the ${ref.source}.`)
  }

  const current = useChatStore.getState().threads[ctx.threadId] ?? ctx.thread

  const enabled = hasRef(current.config.enabledSkills, ref)
    ? current
    : patchThreadConfig(current, {
        enabledSkills: [...current.config.enabledSkills, { ...ref }],
      })

  const directive = skillDirectiveMessage({
    id: ref.id,
    source: ref.source,
    name: manifest.name,
  })
  const next = {
    ...enabled,
    messages: [...enabled.messages, directive],
    updatedAt: Date.now(),
  }
  useChatStore.getState().setThread(next)
  try {
    await ctx.session.threadStore.saveThread(next)
  } catch (error) {
    // Matches the engine's own persist path: a lock clears the chat state, so
    // the thread is dropped rather than reported as a raw vault failure.
    if (error instanceof VaultLockedError) {
      useChatStore.getState().removeThread(ctx.threadId)
      return
    }
    throw error
  }

  // A bare invocation leaves the directive as the last message, so the user's
  // next message follows it directly and only then starts a run. With trailing
  // text there is something to answer, so exactly one run starts, after the
  // directive is already durable.
  if (trailingText.trim().length === 0) return
  await ctx.session.engineFor(ctx.threadId).sendTurn(ctx.threadId, trailingText)
}
