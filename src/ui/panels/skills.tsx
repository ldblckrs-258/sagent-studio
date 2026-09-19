import { useEffect, useRef, useState } from 'react'
import { Sparkles, Trash2, Upload } from 'lucide-react'
import { useSession } from '../../session/session-context'
import { useWorkspaceStore } from '../../session/workspace-state'
import { parseSkillMarkdown } from '../../skills/parser'
import type { SkillManifest } from '../../skills/schema'
import { createWorkspaceSkillSource } from '../../skills/workspace-source'
import {
  Badge,
  Button,
  EmptyState,
  Field,
  IconButton,
  Input,
  PanelSection,
  Textarea,
  Toggle,
} from '../primitives'

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

const SKILL_SOURCES = ['vault', 'workspace'] as const
const SOURCE_LABEL: Record<(typeof SKILL_SOURCES)[number], string> = {
  vault: 'Vault',
  workspace: 'Workspace',
}

interface EditState {
  id: string
  source: 'vault' | 'workspace'
  name: string
  description: string
  instructions: string
  allowedTools: string
}

export function SkillsPanel() {
  const session = useSession()
  const workspace = useWorkspaceStore((s) => s.fs)
  const [version, setVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<EditState | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!workspace) return
      try {
        await session.skillRegistry.loadWorkspaceSkills(createWorkspaceSkillSource(workspace))
        if (!cancelled) setVersion((value) => value + 1)
      } catch (cause) {
        if (!cancelled) setError(messageOf(cause))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspace, session])

  const skills = session.skillRegistry.list()

  const toggle = async (manifest: SkillManifest, enabled: boolean) => {
    const ref = { id: manifest.id, source: manifest.source }
    // Any currently-disabled skill requires explicit confirmation before it can
    // influence the model. This is durable across reload without persisting a
    // separate untrusted flag.
    if (enabled && !session.skillRegistry.isEnabled(ref)) {
      const ok = window.confirm(
        `Enabling "${manifest.name}" lets its instructions influence the model. Continue?`,
      )
      if (!ok) return
    }
    session.skillRegistry.setEnabled(ref, enabled)
    try {
      await session.skillRegistry.persistEnabled()
      setError(null)
      setVersion((value) => value + 1)
    } catch (cause) {
      session.skillRegistry.setEnabled(ref, !enabled)
      setError(messageOf(cause))
    }
  }

  const startEdit = (manifest: SkillManifest) => {
    setEditing({
      id: manifest.id,
      source: manifest.source,
      name: manifest.name,
      description: manifest.description,
      instructions: manifest.instructions,
      allowedTools: manifest.allowedTools.join(', '),
    })
  }

  const commitEdit = async () => {
    if (!editing) return
    const manifest: SkillManifest = {
      id: editing.id,
      name: editing.name.trim() || editing.id,
      description: editing.description,
      instructions: editing.instructions,
      allowedTools: editing.allowedTools
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
      source: editing.source,
    }
    try {
      await session.skillRegistry.updateSkill(manifest)
      setEditing(null)
      setError(null)
      setVersion((value) => value + 1)
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  const remove = async (manifest: SkillManifest) => {
    if (!window.confirm(`Remove "${manifest.name}"?`)) return
    try {
      await session.skillRegistry.removeSkill({ id: manifest.id, source: manifest.source })
      setError(null)
      setVersion((value) => value + 1)
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  const importFile = async (file: File) => {
    try {
      const text = await file.text()
      const parsed = parseSkillMarkdown(text, file.name.replace(/\.md$/i, ''))
      const manifest: SkillManifest = {
        id: parsed.name,
        name: parsed.name,
        description: parsed.description,
        instructions: parsed.instructions,
        allowedTools: parsed.allowedTools,
        source: 'vault',
      }
      await session.skillRegistry.importSkill(manifest)
      setError(null)
      setVersion((value) => value + 1)
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  const groups = SKILL_SOURCES.map((source) => ({
    source,
    items: skills.filter((manifest) => manifest.source === source),
  })).filter((group) => group.items.length > 0)

  return (
    <div className="flex flex-col gap-3 p-2" data-skills-version={version}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-baseline gap-1.5">
          <span className="label-micro">Registered</span>
          <span className="numeric font-mono text-xs text-faint">{skills.length}</span>
        </span>
        <Button
          size="sm"
          variant="secondary"
          icon={<Upload size={14} strokeWidth={1.75} />}
          onClick={() => fileInput.current?.click()}
        >
          Import
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".md,text/markdown"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void importFile(file)
            event.target.value = ''
          }}
        />
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-sm border border-danger-rule bg-danger-soft px-2 py-1 font-mono text-xs text-danger"
        >
          {error}
        </p>
      ) : null}

      {skills.length === 0 ? (
        <EmptyState
          icon={<Sparkles size={18} strokeWidth={1.5} />}
          title="No skills registered"
          hint="Import a SKILL.md file, or drop one in the workspace folder."
        />
      ) : null}

      {groups.map((group) => (
        <PanelSection
          key={group.source}
          label={SOURCE_LABEL[group.source]}
          count={group.items.length}
          hint={
            group.source === 'workspace'
              ? 'Read from the workspace folder; edit the file itself to change one.'
              : undefined
          }
        >
          <ul className="flex flex-col gap-1.5">
            {group.items.map((manifest) => {
              const ref = { id: manifest.id, source: manifest.source }
              const enabled = session.skillRegistry.isEnabled(ref)
              const isEditing =
                editing !== null && editing.id === manifest.id && editing.source === manifest.source
              return (
                <li
                  key={`${manifest.source}:${manifest.id}`}
                  className="rounded-sm border border-rule bg-surface"
                >
                  {isEditing ? (
                    <div className="flex flex-col gap-2 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="label-micro">Editing</span>
                        <span className="truncate font-mono text-xs text-faint">{editing.id}</span>
                      </div>
                      <Field label="Name">
                        <Input
                          size="sm"
                          value={editing.name}
                          onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                        />
                      </Field>
                      <Field label="Description">
                        <Input
                          size="sm"
                          value={editing.description}
                          onChange={(event) =>
                            setEditing({ ...editing, description: event.target.value })
                          }
                        />
                      </Field>
                      <Field label="Instructions">
                        <Textarea
                          size="sm"
                          className="min-h-28 font-mono"
                          value={editing.instructions}
                          onChange={(event) =>
                            setEditing({ ...editing, instructions: event.target.value })
                          }
                        />
                      </Field>
                      <Field label="Allowed tools">
                        <Input
                          size="sm"
                          placeholder="Comma-separated tool names"
                          value={editing.allowedTools}
                          onChange={(event) =>
                            setEditing({ ...editing, allowedTools: event.target.value })
                          }
                        />
                      </Field>
                      <div className="flex gap-1.5">
                        <Button size="sm" variant="primary" onClick={() => void commitEdit()}>
                          Save
                        </Button>
                        <Button size="sm" variant="quiet" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 p-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium text-ink">
                              {manifest.name}
                            </span>
                            {enabled ? null : <Badge tone="caution">off</Badge>}
                          </div>
                          {manifest.description ? (
                            <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">
                              {manifest.description}
                            </p>
                          ) : null}
                        </div>
                        <Toggle
                          checked={enabled}
                          label={`Enable ${manifest.name}`}
                          onCheckedChange={(next) => void toggle(manifest, next)}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-2 border-t border-rule px-2 py-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate font-mono text-xs text-faint">{manifest.id}</span>
                          {manifest.allowedTools.length > 0 ? (
                            <Badge title={manifest.allowedTools.join(', ')}>
                              {manifest.allowedTools.length} tools
                            </Badge>
                          ) : null}
                        </div>
                        {manifest.source === 'vault' ? (
                          <div className="flex shrink-0 items-center gap-0.5">
                            <Button
                              size="sm"
                              variant="quiet"
                              onClick={() => startEdit(manifest)}
                            >
                              Edit
                            </Button>
                            <IconButton
                              label={`Remove ${manifest.name}`}
                              tone="danger"
                              onClick={() => void remove(manifest)}
                            >
                              <Trash2 size={14} strokeWidth={1.75} />
                            </IconButton>
                          </div>
                        ) : (
                          <span className="shrink-0 text-xs text-faint">read-only</span>
                        )}
                      </div>
                    </>
                  )}
                </li>
              )
            })}
          </ul>
        </PanelSection>
      ))}

      {skills.length > 0 ? (
        <p className="text-xs leading-relaxed text-faint">
          Imported and workspace skills stay disabled until you enable them.
        </p>
      ) : null}
    </div>
  )
}
