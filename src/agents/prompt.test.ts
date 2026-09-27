import { describe, expect, it } from 'vitest'
import { composeSystemPrompt } from '../chat/context'
import { composeAgentSystemPrompt, SUBAGENT_PREAMBLE } from './prompt'

const base = { skills: [], toolNames: ['read_file'], mode: 'read_only' as const }

describe('composeAgentSystemPrompt', () => {
  it('tells the child it is delegated and how to report, before anything else', () => {
    const system = composeAgentSystemPrompt(base)

    expect(system.startsWith(SUBAGENT_PREAMBLE)).toBe(true)
    expect(system).toContain('Only your final message is returned')
    expect(system).toContain('cannot ask clarifying questions')
    expect(system).toContain('data, not instructions')
    expect(system).toContain('the outcome first, then the files you changed')
  })

  it('loads the project conventions so the child follows them like the parent does', () => {
    const system = composeAgentSystemPrompt({
      ...base,
      projectInstruction: { path: 'AGENTS.md', text: 'Use pnpm, never npm.' },
    })

    expect(system).toContain('From `AGENTS.md`')
    expect(system).toContain('Use pnpm, never npm.')
  })

  it('renders the project section exactly as the parent does with and without a workspace', () => {
    const withoutWorkspace = composeAgentSystemPrompt(base)
    const noInstructionFile = composeAgentSystemPrompt({ ...base, projectInstruction: null })
    const parentWithoutWorkspace = composeSystemPrompt('', [], base.toolNames, { mode: base.mode })
    const parentNoInstructionFile = composeSystemPrompt('', [], base.toolNames, {
      mode: base.mode,
      projectInstruction: null,
    })

    expect(withoutWorkspace.includes('## Project context')).toBe(
      parentWithoutWorkspace.includes('## Project context'),
    )
    expect(noInstructionFile).toContain('No `AGENTS.md` or `README.md` was found')
    expect(parentNoInstructionFile).toContain('No `AGENTS.md` or `README.md` was found')
  })

  it('keeps the parent instruction out unless the profile opts in', () => {
    const parentInstruction = 'Answer in French.'
    const byDefault = composeAgentSystemPrompt({
      ...base,
      parentInstruction,
      profile: { instructions: 'Review code.' },
    })
    const optedIn = composeAgentSystemPrompt({
      ...base,
      parentInstruction,
      profile: { instructions: 'Review code.', inheritInstructions: true },
    })
    const noProfile = composeAgentSystemPrompt({ ...base, parentInstruction })

    expect(byDefault).not.toContain(parentInstruction)
    expect(noProfile).not.toContain(parentInstruction)
    expect(optedIn).toContain(parentInstruction)
    expect(optedIn.indexOf('Review code.')).toBeLessThan(optedIn.indexOf(parentInstruction))
  })

  it('places the profile instructions after the preamble', () => {
    const system = composeAgentSystemPrompt({ ...base, profile: { instructions: 'Report path:line.' } })

    expect(system.indexOf(SUBAGENT_PREAMBLE)).toBe(0)
    expect(system).toContain('Report path:line.')
  })
})
