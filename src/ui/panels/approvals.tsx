import { COMMAND_TOOLS, isGatedTool } from '../../tools/approval'
import type { ToolGateKind } from '../../tools/approval'
import { useSession } from '../../session/session-context'
import type { ApprovalDecision } from '../../vault/settings'
import { useVaultStore } from '../../vault/store'
import { Row } from '../primitives'
import { useRegistryVersion } from '../use-registry-version'

interface GatedEntry {
  name: string
  kind: ToolGateKind
}

/**
 * Lists the gated tools by running the same `isGatedTool` predicate the gate
 * uses, so the panel can never drift from the enforcement list.
 */
export function ApprovalsPanel() {
  const session = useSession()
  const policy = useVaultStore((s) => s.settings?.approvals?.tools ?? {})
  const update = useVaultStore((s) => s.update)

  const builtins: GatedEntry[] = session
    .builtinProviders()
    .map((entry) => ({ name: entry.name, kind: 'builtin' as const }))
  useRegistryVersion(session.toolRegistry)
  const userTools: GatedEntry[] = session.toolRegistry
    .list()
    .map((definition) => ({ name: definition.name, kind: definition.kind }))
  const externalTools: GatedEntry[] = session.toolRegistry.listExternal()
  const gated = [...builtins, ...userTools, ...externalTools].filter((tool) => isGatedTool(tool))

  const setDecision = (name: string, decision: ApprovalDecision) => {
    void update({ approvals: { tools: { [name]: decision } } })
  }

  return (
    <div className="flex flex-col p-2">
      <p className="px-1 pb-2 text-xs leading-relaxed text-muted">
        Destructive, code-running, and network tools ask before they run. A persisted Deny blocks even
        in the god mode.
      </p>
      {gated.some((tool) => COMMAND_TOOLS.has(tool.name)) ? (
        <p className="px-1 pb-2 text-xs leading-relaxed text-muted">
          Allow runs sensitive commands without asking.
        </p>
      ) : null}
      {gated.length === 0 ? (
        <p className="px-1 text-xs text-muted">No gated tools are registered.</p>
      ) : (
        gated.map((tool) => (
          <Row key={tool.name} label={tool.name} hint={tool.kind === 'builtin' ? undefined : tool.kind}>
            <select
              aria-label={`Decision for ${tool.name}`}
              className="h-7 rounded-sm border border-rule bg-surface px-1 text-xs text-ink"
              value={policy[tool.name] ?? 'ask'}
              onChange={(event) => setDecision(tool.name, event.target.value as ApprovalDecision)}
            >
              <option value="allow">Allow</option>
              <option value="ask">Ask</option>
              <option value="deny">Deny</option>
            </select>
          </Row>
        ))
      )}
    </div>
  )
}
