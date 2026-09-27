import type { WorkspaceApi } from '../tools/types'
import { WorkspaceNotFoundError } from '../workspace/errors'
import { parseAgentProfileMarkdown } from './profiles'
import type { AgentProfile, AgentProfileLoadError, AgentProfileSource } from './profiles'

export const WORKSPACE_AGENTS_ROOT = '.agents/agents'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createWorkspaceProfileSource(workspace: WorkspaceApi): AgentProfileSource {
  return {
    list: async () => {
      const profiles: AgentProfile[] = []
      const errors: AgentProfileLoadError[] = []
      let entries
      try {
        entries = await workspace.list(WORKSPACE_AGENTS_ROOT)
      } catch (error) {
        if (error instanceof WorkspaceNotFoundError) return { profiles, errors }
        throw error
      }
      for (const entry of entries) {
        if (entry.kind !== 'file' || !entry.name.toLowerCase().endsWith('.md')) continue
        const id = entry.name.slice(0, -3)
        if (id.length === 0) continue
        try {
          const parsed = parseAgentProfileMarkdown(await workspace.readFile(entry.path), id)
          profiles.push({ ...parsed, source: 'workspace', path: entry.path })
        } catch (error) {
          errors.push({ path: entry.path, message: messageOf(error) })
        }
      }
      return { profiles, errors }
    },
  }
}
