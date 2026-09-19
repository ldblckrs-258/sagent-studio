import { WorkspaceNotFoundError } from '../workspace/errors'
import type { WorkspaceApi } from '../tools/types'
import { parseSkillMarkdown } from './parser'
import type { SkillSource } from './registry'
import { SkillParseError } from './schema'
import type { SkillManifest } from './schema'

export const WORKSPACE_SKILLS_ROOT = '.agents/skills'

async function collect(
  workspace: WorkspaceApi,
  directory: string,
  out: SkillManifest[],
): Promise<void> {
  let entries
  try {
    entries = await workspace.list(directory)
  } catch (error) {
    if (error instanceof WorkspaceNotFoundError) return
    throw error
  }

  for (const entry of entries) {
    if (entry.kind !== 'directory') continue
    const skillPath = `${entry.path}/SKILL.md`
    try {
      const markdown = await workspace.readFile(skillPath)
      const parsed = parseSkillMarkdown(markdown, entry.name)
      out.push({
        id: entry.path,
        name: parsed.name,
        description: parsed.description,
        instructions: parsed.instructions,
        allowedTools: parsed.allowedTools,
        source: 'workspace',
        path: skillPath,
      })
    } catch (error) {
      if (!(error instanceof WorkspaceNotFoundError) && !(error instanceof SkillParseError)) {
        throw error
      }
    }
    await collect(workspace, entry.path, out)
  }
}

export function createWorkspaceSkillSource(workspace: WorkspaceApi): SkillSource {
  return {
    list: async () => {
      const manifests: SkillManifest[] = []
      await collect(workspace, WORKSPACE_SKILLS_ROOT, manifests)
      return manifests
    },
  }
}
