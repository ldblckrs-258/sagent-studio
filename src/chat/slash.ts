import type { SkillRegistry } from '../skills/registry'
import type { AppSession } from '../session/session'
import { ChatError } from './errors'
import { invokeSkill } from './skill-invoke'
import type { ChatThread, SkillRef } from './types'

export interface SlashContext {
  session: AppSession
  threadId: string
  thread: ChatThread
}

/**
 * A built-in command. Registering one is the whole cost of adding a command:
 * the composer's suggestion list and the send path both read this registry, so
 * neither has to learn the new name.
 */
export interface SlashCommand {
  id: string
  label: string
  description: string
  argumentHint?: string
  run(ctx: SlashContext, args: string): Promise<void>
}

/**
 * One row of the namespace. Built-in commands and installed skills are the same
 * shape here on purpose, so the user searches a single list and the send path
 * has a single dispatch.
 */
export interface SlashEntry extends SlashCommand {
  kind: 'command' | 'skill'
  /** Set for a skill entry, so the list can tag an untrusted workspace source. */
  source?: 'vault' | 'workspace'
}

export interface SlashInput {
  isSlash: boolean
  /** The typed name, which may still carry an `@vault` or `@workspace` suffix. */
  name: string
  args: string
}

export class UnknownSlashCommandError extends ChatError {
  constructor(name: string, available: readonly string[], typed?: string) {
    const list = available.length > 0 ? available.map((id) => `/${id}`).join(', ') : 'none'
    // The composer clears its draft before the send resolves, so the text is
    // gone by the time this is thrown. Carrying it in the message is what keeps
    // a mistyped command from losing what the user wrote.
    const unsent =
      typed !== undefined && typed.trim().length > 0
        ? ` Nothing was sent; your message was: ${typed.trim()}`
        : ''
    super(`There is no command or skill called "/${name}". Available: ${list}.${unsent}`)
    this.name = 'UnknownSlashCommandError'
  }
}

/**
 * Whether text should be routed to the registry at all.
 *
 * A leading slash alone is not enough: `/tmp/foo is missing` and `/usr/bin is
 * on PATH` are prose, and treating them as commands would fail to resolve and
 * discard what the user typed. A command name is a single unbroken token, so an
 * inner slash disqualifies it — while a genuine typo like `/compct` still
 * reaches the registry and reports the available entries.
 */
const COMMAND_SHAPE = /^\/[A-Za-z0-9_@.-]+(\s|$)/

export function looksLikeSlashCommand(text: string): boolean {
  return COMMAND_SHAPE.test(text.trimStart())
}

export function parseSlashInput(text: string): SlashInput {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('/')) return { isSlash: false, name: '', args: '' }
  const body = trimmed.slice(1)
  const split = body.search(/\s/)
  if (split === -1) return { isSlash: true, name: body, args: '' }
  return {
    isSlash: true,
    name: body.slice(0, split),
    args: body.slice(split).trim(),
  }
}

function splitSource(name: string): {
  base: string
  source?: 'vault' | 'workspace'
} {
  const at = name.lastIndexOf('@')
  if (at <= 0) return { base: name }
  const suffix = name.slice(at + 1)
  if (suffix !== 'vault' && suffix !== 'workspace') return { base: name }
  return { base: name.slice(0, at), source: suffix }
}

function skillEntry(
  ref: SkillRef,
  name: string,
  description: string,
  ambiguous: boolean,
): SlashEntry {
  return {
    // A duplicated id needs the suffix to be reachable; a unique one stays
    // short, because the suffix is noise when there is nothing to disambiguate.
    id: ambiguous && ref.source === 'workspace' ? `${ref.id}@workspace` : ref.id,
    label: name,
    description,
    argumentHint: '[what to do]',
    kind: 'skill',
    source: ref.source,
    run: (ctx, args) => invokeSkill(ctx, ref, args),
  }
}

/**
 * The namespace: built-in commands, then every globally enabled skill. The
 * enablement filter mirrors the one `ComposerControls` applies, so a skill the
 * user has not trusted globally is neither listed nor invocable, and a built-in
 * command wins a name collision because its behavior is fixed.
 */
export function slashEntries(
  commands: readonly SlashCommand[],
  skillRegistry: SkillRegistry,
): SlashEntry[] {
  const builtins: SlashEntry[] = commands.map((command) => ({
    ...command,
    kind: 'command',
  }))
  const reserved = new Set(builtins.map((entry) => entry.id))

  const enabled = skillRegistry
    .list()
    .filter((skill) => skillRegistry.isEnabled({ id: skill.id, source: skill.source }))
  const counts = new Map<string, number>()
  for (const skill of enabled) counts.set(skill.id, (counts.get(skill.id) ?? 0) + 1)

  const skills = enabled
    .filter((skill) => !reserved.has(skill.id))
    .map((skill) =>
      skillEntry(
        { id: skill.id, source: skill.source },
        skill.name,
        skill.description,
        (counts.get(skill.id) ?? 0) > 1,
      ),
    )
  return [...builtins, ...skills]
}

/**
 * Resolves a typed name. A built-in command matches first; among skills, an
 * unsuffixed name resolves to the vault entry, because the vault is the source
 * the user has explicitly imported and is therefore the safer default.
 */
export function resolveSlash(
  entries: readonly SlashEntry[],
  name: string,
): SlashEntry | undefined {
  const { base, source } = splitSource(name)
  if (source === undefined) {
    const command = entries.find((entry) => entry.kind === 'command' && entry.id === name)
    if (command) return command
  }
  const skills = entries.filter((entry) => entry.kind === 'skill')
  const matching = skills.filter((entry) => {
    const { base: entryBase } = splitSource(entry.id)
    return entryBase === base
  })
  if (source !== undefined) {
    return matching.find((entry) => entry.source === source)
  }
  return (
    matching.find((entry) => entry.source === 'vault') ??
    matching.find((entry) => entry.id === base)
  )
}

export async function runSlashCommand(
  entries: readonly SlashEntry[],
  ctx: SlashContext,
  text: string,
): Promise<void> {
  const { isSlash, name, args } = parseSlashInput(text)
  const entry = isSlash && name.length > 0 ? resolveSlash(entries, name) : undefined
  if (!entry) {
    throw new UnknownSlashCommandError(
      name,
      entries.map((candidate) => candidate.id),
      text,
    )
  }
  await entry.run(ctx, args)
}

/**
 * Compacts the conversation. Trailing text becomes the summarization focus, and
 * no model turn follows: the point is to shrink what the next turn sends, not to
 * start one.
 */
export const compactCommand: SlashCommand = {
  id: 'compact',
  label: '/compact',
  description: 'Summarize this conversation and continue from the summary',
  argumentHint: '[what to keep]',
  run: async (ctx, args) => {
    await ctx.session.engineFor(ctx.threadId).compact(ctx.threadId, args)
  },
}

export const BUILTIN_SLASH_COMMANDS: readonly SlashCommand[] = [compactCommand]

/** Convenience for the send path and the composer, which need the same list. */
export function defaultSlashEntries(skillRegistry: SkillRegistry): SlashEntry[] {
  return slashEntries(BUILTIN_SLASH_COMMANDS, skillRegistry)
}
