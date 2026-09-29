import { jsonSchema, tool } from 'ai'
import { toolFail, toolOk, wrapToolExecute } from '../result'
import { ToolNotFoundError } from '../types'
import type { ToolProvider } from '../types'
import agentsGuide from './guides/agents.md?raw'
import checkpointsGuide from './guides/checkpoints.md?raw'
import customToolsGuide from './guides/custom-tools.md?raw'
import mcpGuide from './guides/mcp.md?raw'
import memoryGuide from './guides/memory.md?raw'
import ragGuide from './guides/rag.md?raw'
import sandboxGuide from './guides/sandbox.md?raw'
import skillsGuide from './guides/skills.md?raw'
import terminalGuide from './guides/terminal.md?raw'
import workspaceEditGuide from './guides/workspace-edit.md?raw'

const NAMES = ['read_tool_guide'] as const

interface ToolGuideEntry {
  topic: string
  summary: string
  covers: readonly string[]
  guide: string
}

const ENTRIES: readonly ToolGuideEntry[] = [
  {
    topic: 'custom_tools',
    summary: 'Defining sandbox-js and http user tools, including {{input.x}} templating.',
    covers: ['list_user_tools', 'create_tool', 'update_tool', 'delete_tool', 'call_user_tool'],
    guide: customToolsGuide,
  },
  {
    topic: 'sandbox',
    summary: 'Running JavaScript and Python: timeouts, persistence, workspace bridge, packages.',
    covers: ['run_js', 'run_python', 'reset_sandbox'],
    guide: sandboxGuide,
  },
  {
    topic: 'workspace_edit',
    summary: 'Revisions, exact-match edits, and recovering from no_match or stale_write.',
    covers: ['read_file', 'write_file', 'edit_file', 'search', 'find_lines', 'list_dir'],
    guide: workspaceEditGuide,
  },
  {
    topic: 'checkpoints',
    summary: 'Journaled writes, restore points, and inspecting what changed.',
    covers: ['checkpoint', 'restore', 'diff', 'history'],
    guide: checkpointsGuide,
  },
  {
    topic: 'skills',
    summary: 'Loading skills, trusted versus untrusted sources, and authoring vault skills.',
    covers: ['load_skill', 'search_skills', 'list_skills', 'create_skill', 'update_skill', 'delete_skill'],
    guide: skillsGuide,
  },
  {
    topic: 'rag',
    summary: 'Searching the encrypted document library and verifying citations.',
    covers: ['list_documents', 'search_documents', 'get_chunk', 'get_neighbors', 'verify_citation'],
    guide: ragGuide,
  },
  {
    topic: 'agents',
    summary: 'Delegating a bounded task to a nested sub-agent, inline or in the background.',
    covers: ['spawn_agent', 'message_agent', 'wait_agents'],
    guide: agentsGuide,
  },
  {
    topic: 'memory',
    summary: 'Saving, scoping, flagging, and recalling personal memories about the user.',
    covers: ['remember', 'update_memory', 'forget', 'recall_memory'],
    guide: memoryGuide,
  },
  {
    topic: 'mcp',
    summary: 'Tools, resources, and prompts from connected MCP servers, and why their content is untrusted.',
    covers: ['list_mcp_resources', 'read_mcp_resource'],
    guide: mcpGuide,
  },
  {
    topic: 'terminal',
    summary: 'Running shell commands and sessions on the user\'s machine through the paired bridge.',
    covers: ['run_command', 'terminal_start', 'terminal_write', 'terminal_read', 'terminal_kill', 'terminal_list'],
    guide: terminalGuide,
  },
]

const BY_TOPIC = new Map(ENTRIES.map((entry) => [entry.topic, entry]))

const BY_ALIAS = new Map(
  ENTRIES.flatMap((entry) => entry.covers.map((name) => [name, entry] as const)),
)

export const TOOL_GUIDE_TOPICS: readonly string[] = ENTRIES.map((entry) => entry.topic)

function resolveToolGuide(topic: string): ToolGuideEntry | undefined {
  const key = topic.trim().toLowerCase()
  return BY_TOPIC.get(key) ?? BY_ALIAS.get(key)
}

export function toolGuideHint(topic: string): string {
  return `Call read_tool_guide with topic "${topic}" for the rules and examples.`
}

function readTopic(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const topic = (input as { topic?: unknown }).topic
  return typeof topic === 'string' ? topic : ''
}

function index() {
  return ENTRIES.map((entry) => ({
    topic: entry.topic,
    summary: entry.summary,
    covers: entry.covers,
  }))
}

export function createToolGuideProvider(): ToolProvider {
  return {
    names: NAMES,
    isAvailable: () => true,
    create(name) {
      if (name !== 'read_tool_guide') throw new ToolNotFoundError(name)
      return tool({
        description:
          'Read the usage guide for a group of complex tools. Call it without arguments to list the topics, or pass a topic (or any tool name it covers) to get the rules, limits, and examples. Read the guide before first use of a topic and after a call from it fails.',
        inputSchema: jsonSchema<{ topic?: string }>({
          type: 'object',
          properties: { topic: { type: 'string' } },
        } as Parameters<typeof jsonSchema>[0]),
        execute: wrapToolExecute(async (input) => {
          const requested = readTopic(input)
          if (requested.trim().length === 0) return toolOk({ topics: index() })
          const entry = resolveToolGuide(requested)
          if (!entry) {
            return toolFail('not_found', `No tool guide covers "${requested}".`, {
              hint: `Available topics: ${TOOL_GUIDE_TOPICS.join(', ')}.`,
            })
          }
          return toolOk({ topic: entry.topic, covers: entry.covers, guide: entry.guide })
        }),
      })
    },
  }
}
