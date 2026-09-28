import type { GetPromptResult, Prompt } from '@modelcontextprotocol/sdk/types.js'
import { ChatError } from '../chat/errors'
import type { SlashContext, SlashEntry } from '../chat/slash'
import { describeMcpError } from './errors'
import type { McpConnectionManager, McpStoreState } from './manager'
import { serverSlug } from './types'

export const MCP_PROMPT_PREFIX = 'mcp.'

type PromptManager = Pick<McpConnectionManager, 'store' | 'getPrompt'>

export function mcpPromptId(serverName: string, promptName: string): string {
  const slug = promptName.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'prompt'
  return `${serverSlug(serverName)}.${slug}`
}

function argumentHint(prompt: Prompt): string | undefined {
  const args = prompt.arguments ?? []
  if (args.length === 0) return undefined
  if (args.length === 1) {
    const only = args[0]!
    return only.required ? `<${only.name}>` : `[${only.name}]`
  }
  return args.map((arg) => (arg.required ? `${arg.name}=<value>` : `[${arg.name}=…]`)).join(' ')
}

const PAIR = /([A-Za-z0-9_.-]+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g

export function parsePromptArguments(
  prompt: Pick<Prompt, 'name' | 'arguments'>,
  text: string,
): { args: Record<string, string>; extra: string } {
  const declared = prompt.arguments ?? []
  const trimmed = text.trim()
  const describe = () =>
    declared.map((arg) => `${arg.name}${arg.required ? ' (required)' : ''}`).join(', ')
  if (declared.length === 0) return { args: {}, extra: trimmed }
  let args: Record<string, string> = {}
  if (declared.length === 1) {
    if (trimmed.length > 0) args = { [declared[0]!.name]: trimmed }
  } else {
    const known = new Set(declared.map((arg) => arg.name))
    const leftover = trimmed.replace(PAIR, (_match, key: string, double?: string, single?: string, bare?: string) => {
      if (!known.has(key)) {
        throw new ChatError(`The MCP prompt "${prompt.name}" has no argument "${key}". Arguments: ${describe()}.`)
      }
      args[key] = double ?? single ?? bare ?? ''
      return ''
    })
    if (leftover.trim().length > 0) {
      throw new ChatError(
        `Pass arguments to the MCP prompt "${prompt.name}" as name=value pairs. Arguments: ${describe()}.`,
      )
    }
  }
  const missing = declared.filter((arg) => arg.required && !(arg.name in args))
  if (missing.length > 0) {
    throw new ChatError(
      `The MCP prompt "${prompt.name}" needs ${missing.map((arg) => arg.name).join(', ')}. Arguments: ${describe()}. Nothing was sent.`,
    )
  }
  return { args, extra: '' }
}

export function promptResultText(result: GetPromptResult): string {
  const blocks: string[] = []
  for (const message of result.messages) {
    const content = message.content
    let text: string
    if (content.type === 'text') {
      text = content.text
    } else if (content.type === 'resource' && 'text' in content.resource && typeof content.resource.text === 'string') {
      text = `\`\`\`\n${content.resource.text}\n\`\`\``
    } else if (content.type === 'resource_link') {
      text = `[resource: ${content.uri}]`
    } else if (content.type === 'resource') {
      text = `[resource: ${content.resource.uri}${content.resource.mimeType ? `, ${content.resource.mimeType}` : ''}]`
    } else {
      text = `[${content.type}${'mimeType' in content && content.mimeType ? `, ${content.mimeType}` : ''}]`
    }
    blocks.push(message.role === 'assistant' ? `Assistant: ${text}` : text)
  }
  return blocks.join('\n\n')
}

export async function invokeMcpPrompt(
  ctx: SlashContext,
  manager: PromptManager,
  serverId: string,
  prompt: Prompt,
  text: string,
): Promise<void> {
  const { args, extra } = parsePromptArguments(prompt, text)
  let result: GetPromptResult
  try {
    result = await manager.getPrompt(serverId, prompt.name, args)
  } catch (error) {
    throw new ChatError(`The MCP prompt "${prompt.name}" failed: ${describeMcpError(error)}`, {
      cause: error,
    })
  }
  const body = [promptResultText(result), extra].filter((part) => part.trim().length > 0).join('\n\n')
  if (body.trim().length === 0) {
    throw new ChatError(`The MCP prompt "${prompt.name}" returned no text. Nothing was sent.`)
  }
  await ctx.session.engineFor(ctx.threadId).sendTurn(ctx.threadId, body)
}

export function mcpPromptEntries(
  manager: PromptManager,
  state: McpStoreState = manager.store.getState(),
): SlashEntry[] {
  const entries: SlashEntry[] = []
  const seen = new Set<string>()
  for (const id of state.order) {
    const view = state.servers[id]
    if (!view || view.state !== 'ready') continue
    for (const prompt of view.catalog.prompts) {
      const id = mcpPromptId(view.config.name, prompt.name)
      if (seen.has(id)) continue
      seen.add(id)
      const hint = argumentHint(prompt)
      const serverId = view.config.id
      entries.push({
        id,
        label: prompt.title ?? prompt.name,
        description: `[MCP: ${view.config.name}] ${prompt.description ?? prompt.title ?? prompt.name}`,
        ...(hint !== undefined ? { argumentHint: hint } : {}),
        kind: 'mcp-prompt',
        run: (ctx, args) => invokeMcpPrompt(ctx, manager, serverId, prompt, args),
      })
    }
  }
  return entries
}
