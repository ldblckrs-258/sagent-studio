import { useEffect, useState } from 'react'
import { Brain, Pin, Plus, Trash2 } from 'lucide-react'
import { formatAge } from '../../components/assistant-ui/elements/tool-view/helpers'
import { useMemoryStore } from '../../memory/state'
import { MEMORY_BODY_MAX, MEMORY_TITLE_MAX } from '../../memory/types'
import type { Memory, MemoryDraft } from '../../memory/types'
import { useWorkspaceStore } from '../../session/workspace-state'
import type { ApprovalDecision } from '../../vault/settings'
import { useVaultStore } from '../../vault/store'
import {
  Badge,
  Button,
  EmptyState,
  Field,
  IconButton,
  Input,
  PanelSection,
  Select,
  Textarea,
  Toggle,
} from '../primitives'

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

type ScopeChoice = 'global' | 'workspace' | 'keep'

const MEMORY_WRITE_TOOLS = ['remember', 'update_memory', 'forget'] as const

interface FormState {
  id: string | null
  title: string
  body: string
  important: boolean
  scope: ScopeChoice
  initialScope: ScopeChoice
  keepLabel: string | null
}

function scopeIdOf(memory: Memory): string | null {
  return memory.scope.kind === 'workspace' ? memory.scope.scopeId : null
}

function newestFirst(a: Memory, b: Memory): number {
  return b.updatedAt - a.updatedAt
}

function MemoryForm({
  form,
  hasFolder,
  error,
  onChange,
  onSave,
  onCancel,
}: {
  form: FormState
  hasFolder: boolean
  error: string | null
  onChange(next: FormState): void
  onSave(): void
  onCancel(): void
}) {
  return (
    <div className="flex flex-col gap-2 rounded-sm border border-rule bg-surface p-2">
      <span className="label-micro">{form.id ? 'Editing' : 'New memory'}</span>
      <Field label={`Title · ${form.title.trim().length}/${MEMORY_TITLE_MAX}`}>
        <Input
          size="sm"
          aria-label="Memory title"
          value={form.title}
          onChange={(event) => onChange({ ...form, title: event.target.value })}
        />
      </Field>
      <Field label={`Body · ${form.body.trim().length}/${MEMORY_BODY_MAX}`}>
        <Textarea
          size="sm"
          aria-label="Memory body"
          value={form.body}
          onChange={(event) => onChange({ ...form, body: event.target.value })}
        />
      </Field>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted">Important · shown in full every turn</span>
        <Toggle
          checked={form.important}
          label="Important"
          onCheckedChange={(important) => onChange({ ...form, important })}
        />
      </div>
      <Field label="Scope">
        <Select
          size="sm"
          aria-label="Memory scope"
          value={form.scope}
          onChange={(event) => onChange({ ...form, scope: event.target.value as ScopeChoice })}
        >
          <option value="global">Global</option>
          {hasFolder ? <option value="workspace">This workspace</option> : null}
          {form.keepLabel !== null ? (
            <option value="keep">{`Keep in ${form.keepLabel}`}</option>
          ) : null}
        </Select>
      </Field>
      {error ? (
        <p role="alert" className="font-mono text-xs text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex gap-1.5">
        <Button size="sm" variant="primary" onClick={onSave}>
          Save
        </Button>
        <Button size="sm" variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function MemoryRow({
  memory,
  now,
  folderLabel,
  expanded,
  pendingDelete,
  onToggle,
  onEdit,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  memory: Memory
  now: number
  folderLabel?: string
  expanded: boolean
  pendingDelete: boolean
  onToggle(): void
  onEdit(): void
  onDelete(): void
  onConfirmDelete(): void
  onCancelDelete(): void
}) {
  return (
    <li className="rounded-sm border border-rule bg-surface" data-memory-id={memory.id}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 p-2 text-left"
      >
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{memory.title}</span>
        {memory.important ? (
          <Badge tone="accent" size="sm" title="Important">
            <Pin size={10} strokeWidth={2} />
          </Badge>
        ) : null}
        {folderLabel !== undefined ? <Badge size="sm">{folderLabel}</Badge> : null}
        <Badge size="sm" tone={memory.source === 'model' ? 'caution' : 'neutral'}>
          {memory.source}
        </Badge>
        <span className="shrink-0 text-xs text-faint">
          {formatAge(Math.max(0, now - memory.updatedAt))}
        </span>
      </button>
      {expanded ? (
        <div className="flex flex-col gap-2 border-t border-rule p-2">
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted">{memory.body}</p>
          {pendingDelete ? (
            <div
              role="alertdialog"
              aria-label={`Delete ${memory.title}`}
              className="flex items-center gap-1.5 rounded-sm border border-danger-rule bg-danger-soft px-2 py-1.5"
            >
              <span className="min-w-0 flex-1 truncate text-xs text-ink">
                Delete “{memory.title}”?
              </span>
              <Button size="sm" variant="danger" onClick={onConfirmDelete}>
                Delete
              </Button>
              <Button size="sm" variant="quiet" onClick={onCancelDelete}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-xs text-faint">{memory.id}</span>
              <div className="flex shrink-0 items-center gap-0.5">
                <Button size="sm" variant="quiet" onClick={onEdit}>
                  Edit
                </Button>
                <IconButton label={`Delete ${memory.title}`} tone="danger" onClick={onDelete}>
                  <Trash2 size={14} strokeWidth={1.75} />
                </IconButton>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </li>
  )
}

export function MemoryPanel() {
  const memories = useMemoryStore((s) => s.memories)
  const scopes = useMemoryStore((s) => s.scopes)
  const status = useMemoryStore((s) => s.status)
  const loadError = useMemoryStore((s) => s.error)
  const handle = useWorkspaceStore((s) => s.fs?.handle ?? null)
  const [currentScopeId, setCurrentScopeId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const approvals = useVaultStore((s) => s.settings?.approvals?.tools)
  const updateSettings = useVaultStore((s) => s.update)
  const writesAllowed = !MEMORY_WRITE_TOOLS.some((name) => approvals?.[name] === 'deny')
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    let cancelled = false
    void useMemoryStore
      .getState()
      .resolveScope(handle)
      .then((scopeId) => {
        if (!cancelled) setCurrentScopeId(scopeId)
      })
    return () => {
      cancelled = true
    }
  }, [handle, scopes])

  if (status === 'error') {
    return (
      <div className="flex flex-col gap-2 p-2">
        <p
          role="alert"
          className="rounded-sm border border-danger-rule bg-danger-soft px-2 py-1 font-mono text-xs text-danger"
        >
          {loadError ?? 'The memories could not be loaded.'}
        </p>
        <Button size="sm" variant="secondary" onClick={() => void useMemoryStore.getState().hydrate()}>
          Retry
        </Button>
      </div>
    )
  }

  if (status !== 'ready') {
    return (
      <div className="p-2" aria-busy="true">
        <div className="h-4 w-2/3 animate-pulse rounded-sm bg-paper-sunk" />
      </div>
    )
  }

  const sorted = [...memories].sort(newestFirst)
  const global = sorted.filter((memory) => scopeIdOf(memory) === null)
  const current =
    currentScopeId === null ? [] : sorted.filter((memory) => scopeIdOf(memory) === currentScopeId)
  const others = sorted.filter((memory) => {
    const scopeId = scopeIdOf(memory)
    return scopeId !== null && scopeId !== currentScopeId
  })

  const labelOf = (memory: Memory): string =>
    memory.scope.kind === 'workspace'
      ? (scopes[memory.scope.scopeId]?.label ?? memory.scope.label)
      : 'Global'

  const startAdd = () => {
    setFormError(null)
    setForm({
      id: null,
      title: '',
      body: '',
      important: false,
      scope: 'global',
      initialScope: 'global',
      keepLabel: null,
    })
  }

  const startEdit = (memory: Memory) => {
    const scopeId = scopeIdOf(memory)
    const initialScope: ScopeChoice =
      scopeId === null ? 'global' : scopeId === currentScopeId ? 'workspace' : 'keep'
    setFormError(null)
    setForm({
      id: memory.id,
      title: memory.title,
      body: memory.body,
      important: memory.important,
      scope: initialScope,
      initialScope,
      keepLabel: initialScope === 'keep' ? labelOf(memory) : null,
    })
  }

  const save = async () => {
    if (!form) return
    const store = useMemoryStore.getState()
    try {
      if (form.id === null) {
        const draft: MemoryDraft = {
          title: form.title,
          body: form.body,
          important: form.important,
          scope: form.scope === 'workspace' ? 'workspace' : 'global',
        }
        await store.create(draft, { source: 'user', handle })
      } else {
        const patch: Partial<MemoryDraft> = {
          title: form.title,
          body: form.body,
          important: form.important,
          ...(form.scope !== form.initialScope && form.scope !== 'keep' ? { scope: form.scope } : {}),
        }
        await store.update(form.id, patch, { source: 'user', handle })
      }
      setForm(null)
      setFormError(null)
    } catch (cause) {
      setFormError(messageOf(cause))
    }
  }

  const confirmDelete = async (id: string) => {
    setPendingDelete(null)
    try {
      await useMemoryStore.getState().remove(id)
      if (expanded === id) setExpanded(null)
      setError(null)
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  const renderForm = (current: FormState) => (
    <MemoryForm
      form={current}
      hasFolder={handle !== null}
      error={formError}
      onChange={setForm}
      onSave={() => void save()}
      onCancel={() => setForm(null)}
    />
  )

  const renderRows = (items: Memory[], showFolder: boolean) => (
    <ul className="flex flex-col gap-1.5">
      {items.map((memory) =>
        form?.id === memory.id ? (
          <li key={memory.id}>{renderForm(form)}</li>
        ) : (
          <MemoryRow
            key={memory.id}
            memory={memory}
            now={now}
            {...(showFolder ? { folderLabel: labelOf(memory) } : {})}
            expanded={expanded === memory.id}
            pendingDelete={pendingDelete === memory.id}
            onToggle={() => setExpanded(expanded === memory.id ? null : memory.id)}
            onEdit={() => startEdit(memory)}
            onDelete={() => setPendingDelete(memory.id)}
            onConfirmDelete={() => void confirmDelete(memory.id)}
            onCancelDelete={() => setPendingDelete(null)}
          />
        ),
      )}
    </ul>
  )

  const empty = (text: string) => <p className="px-1 text-xs text-faint">{text}</p>

  const setWritesAllowed = async (allowed: boolean) => {
    const decision: ApprovalDecision = allowed ? 'allow' : 'deny'
    try {
      await updateSettings({
        approvals: { tools: Object.fromEntries(MEMORY_WRITE_TOOLS.map((name) => [name, decision])) },
      })
      setError(null)
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  return (
    <div className="flex flex-col gap-3 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-baseline gap-1.5">
          <span className="label-micro">Memories</span>
          <span className="numeric font-mono text-xs text-faint">{memories.length}</span>
        </span>
        <Button
          size="sm"
          variant="secondary"
          icon={<Plus size={14} strokeWidth={1.75} />}
          onClick={startAdd}
        >
          Add
        </Button>
      </div>

      <div className="flex items-center justify-between gap-2 rounded-sm border border-rule px-2 py-1.5">
        <span className="flex min-w-0 flex-col">
          <span className="text-xs text-ink">Let the model save memories</span>
          {writesAllowed ? null : (
            <span className="text-xs text-faint">It can still read the memories below.</span>
          )}
        </span>
        <Toggle
          checked={writesAllowed}
          label="Let the model save memories"
          onCheckedChange={(next) => void setWritesAllowed(next)}
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

      {form !== null && form.id === null ? renderForm(form) : null}

      {memories.length === 0 ? (
        <EmptyState
          icon={<Brain size={18} strokeWidth={1.5} />}
          title="No memories yet"
          hint="The model saves durable facts about you here. You can also add one yourself."
        />
      ) : null}

      <PanelSection label="Global" count={global.length} hint="Shown in every conversation.">
        {global.length > 0 ? renderRows(global, false) : empty('No global memories.')}
      </PanelSection>

      {handle !== null ? (
        <PanelSection
          label="This workspace"
          count={current.length}
          hint={`Shown only in conversations in ${handle.name}.`}
        >
          {current.length > 0 ? renderRows(current, false) : empty('No memories for this folder.')}
        </PanelSection>
      ) : null}

      {others.length > 0 ? (
        <PanelSection
          label="Other workspaces"
          count={others.length}
          hint="Not shown in this conversation."
        >
          {renderRows(others, true)}
        </PanelSection>
      ) : null}
    </div>
  )
}
