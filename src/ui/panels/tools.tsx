import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2, Wrench, X } from 'lucide-react'
import { useSession } from '../../session/session-context'
import { assertHttpDefinition, toolStore } from '../../tools/store'
import {
  ToolNameConflictError,
  ToolSchemaError,
  assertPlainSchema,
  validateToolName,
} from '../../tools/types'
import type { HttpToolDefinition, ToolDefinition } from '../../tools/types'
import { MonacoEditor } from '../monaco-editor'
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  Input,
  PanelSection,
  Row,
  Select,
  Toggle,
} from '../primitives'

interface ToolForm {
  originalName: string | null
  kind: 'http' | 'sandbox-js'
  name: string
  description: string
  inputSchema: string
  enabled: boolean
  source: string
  timeoutMs: string
  method: string
  url: string
  headers: string
  body: string
  allowedOrigins: string
}

const EMPTY_FORM: ToolForm = {
  originalName: null,
  kind: 'http',
  name: '',
  description: '',
  inputSchema: '{"type":"object","properties":{}}',
  enabled: true,
  source: 'return input',
  timeoutMs: '',
  method: 'GET',
  url: '',
  headers: '',
  body: '',
  allowedOrigins: '',
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function parseJsonObject(text: string, field: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ToolSchemaError(`${field} must be valid JSON.`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ToolSchemaError(`${field} must be a JSON object.`)
  }
  return parsed as Record<string, unknown>
}

function parseOptionalPositiveInt(text: string, field: string): number | undefined {
  if (text.trim() === '') return undefined
  const value = Number(text)
  if (!Number.isInteger(value) || value <= 0) throw new ToolSchemaError(`${field} must be a positive integer.`)
  return value
}

function toForm(definition: ToolDefinition): ToolForm {
  const base: ToolForm = {
    ...EMPTY_FORM,
    originalName: definition.name,
    kind: definition.kind,
    name: definition.name,
    description: definition.description,
    inputSchema: JSON.stringify(definition.inputSchema, null, 2),
    enabled: definition.enabled,
  }
  if (definition.kind === 'sandbox-js') {
    return { ...base, source: definition.source, timeoutMs: definition.timeoutMs?.toString() ?? '' }
  }
  return {
    ...base,
    method: definition.request.method ?? 'GET',
    url: definition.request.url,
    headers: definition.request.headers ? JSON.stringify(definition.request.headers, null, 2) : '',
    body: definition.request.body ?? '',
    allowedOrigins: definition.request.allowedOrigins.join(', '),
    timeoutMs: definition.request.timeoutMs?.toString() ?? '',
  }
}

function buildDefinition(form: ToolForm): ToolDefinition {
  const inputSchema = parseJsonObject(form.inputSchema, 'inputSchema')
  const timeoutMs = parseOptionalPositiveInt(form.timeoutMs, 'timeoutMs')
  if (form.kind === 'sandbox-js') {
    return {
      kind: 'sandbox-js',
      name: form.name.trim(),
      description: form.description,
      inputSchema,
      source: form.source,
      enabled: form.enabled,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    }
  }
  const headers = form.headers.trim() === '' ? undefined : parseJsonObject(form.headers, 'headers')
  const request = {
    method: form.method.trim() || undefined,
    url: form.url.trim(),
    ...(headers ? { headers: headers as Record<string, string> } : {}),
    ...(form.body.trim() !== '' ? { body: form.body } : {}),
    allowedOrigins: form.allowedOrigins
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  }
  const definition: HttpToolDefinition = {
    kind: 'http',
    name: form.name.trim(),
    description: form.description,
    inputSchema,
    request,
    enabled: form.enabled,
  }
  return definition
}

function summaryOf(definition: ToolDefinition): string {
  if (definition.kind === 'http') {
    return `${definition.request.method ?? 'GET'} ${definition.request.url}`
  }
  return definition.timeoutMs ? `sandbox · ${definition.timeoutMs} ms` : 'sandbox'
}

function CodeField({
  label,
  hint,
  language,
  value,
  onChange,
}: {
  label: string
  hint?: string
  language: string
  value: string
  onChange(value: string): void
}) {
  return (
    <Row label={label} hint={hint}>
      <div className="h-36 overflow-hidden rounded-sm border border-rule-strong bg-surface">
        <MonacoEditor
          value={value}
          onChange={onChange}
          language={language}
          ariaLabel={label}
          className="h-full"
        />
      </div>
    </Row>
  )
}

export function ToolsPanel() {
  const session = useSession()
  const [form, setForm] = useState<ToolForm | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const formRef = useRef<HTMLElement | null>(null)
  const formOpen = form !== null

  useEffect(() => {
    if (formOpen) formRef.current?.scrollIntoView({ block: 'nearest' })
  }, [formOpen])

  const builtins = session.builtinProviders()
  const builtinNames = new Set(builtins.map((entry) => entry.name))
  const userTools = session.toolRegistry.list()

  const toggle = async (definition: ToolDefinition, enabled: boolean) => {
    session.toolRegistry.setEnabled(definition.name, enabled)
    try {
      await toolStore.save({ ...definition, enabled })
      setError(null)
      setVersion((value) => value + 1)
    } catch (cause) {
      session.toolRegistry.setEnabled(definition.name, !enabled)
      setError(messageOf(cause))
    }
  }

  const remove = async (definition: ToolDefinition) => {
    if (!window.confirm(`Delete tool "${definition.name}"?`)) return
    try {
      // Remove from disk first, then memory, so a store failure cannot leave the
      // registry out of sync with what survives a reload.
      await toolStore.remove(definition.name)
      session.toolRegistry.removeUserTool(definition.name)
      setError(null)
      setVersion((value) => value + 1)
    } catch (cause) {
      setError(messageOf(cause))
    }
  }

  const saveForm = async () => {
    if (!form) return
    const previous = form.originalName
      ? session.toolRegistry.list().find((entry) => entry.name === form.originalName)
      : undefined
    let saved = false
    try {
      const candidate = buildDefinition(form)
      validateToolName(candidate.name)
      assertPlainSchema(candidate.inputSchema)
      if (candidate.kind === 'http') assertHttpDefinition(candidate)

      const renamed = form.originalName !== null && form.originalName !== candidate.name
      if (builtinNames.has(candidate.name) && candidate.name !== form.originalName) {
        throw new ToolNameConflictError(candidate.name)
      }
      if ((renamed || form.originalName === null) && userTools.some((entry) => entry.name === candidate.name)) {
        throw new ToolNameConflictError(candidate.name)
      }

      await toolStore.save(candidate)
      saved = true
      if (form.originalName !== null) {
        // Drop the old registry entry (same name or renamed) before registering.
        try {
          session.toolRegistry.removeUserTool(form.originalName)
        } catch {
          // Not registered in this session; nothing to remove.
        }
        if (renamed) await toolStore.remove(form.originalName)
      }
      session.toolRegistry.registerUserTool(candidate)
      setForm(null)
      setError(null)
      setVersion((value) => value + 1)
    } catch (cause) {
      if (saved) await toolStore.remove(form.name.trim()).catch(() => undefined)
      if (previous) {
        try {
          if (!session.toolRegistry.list().some((entry) => entry.name === previous.name)) {
            session.toolRegistry.registerUserTool(previous)
          }
        } catch {
          // Best-effort restore; the surfaced error is the actionable signal.
        }
      }
      setError(messageOf(cause))
    }
  }

  return (
    <div className="flex flex-col gap-3 p-2" data-tools-version={version}>
      <PanelSection
        label="Builtin"
        count={builtins.length}
        hint="Shipped with the app; availability depends on the workspace and runners."
      >
        {builtins.length === 0 ? (
          <p className="text-xs text-faint">None available.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-rule overflow-hidden rounded-sm border border-rule bg-surface">
            {builtins.map((entry) => (
              <li
                key={entry.name}
                className="flex items-center justify-between gap-2 px-2 py-1.5"
              >
                <span className="truncate font-mono text-xs text-ink">{entry.name}</span>
                <Badge tone={entry.available ? 'positive' : 'neutral'}>
                  {entry.available ? 'ready' : 'unavailable'}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>

      <PanelSection
        label="User tools"
        count={userTools.length}
        action={
          <Button size="sm" variant="secondary" icon={<Plus size={14} strokeWidth={1.75} />} onClick={() => setForm({ ...EMPTY_FORM })}>
            New
          </Button>
        }
      >
        {userTools.length === 0 ? (
          <EmptyState
            icon={<Wrench size={18} strokeWidth={1.5} />}
            title="No user tools"
            hint="Add an HTTP endpoint, or a sandbox JavaScript snippet."
          />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {userTools.map((definition) => (
              <li key={definition.name} className="rounded-sm border border-rule bg-surface">
                <div className="flex items-center gap-2 p-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-mono text-xs text-ink">{definition.name}</span>
                      <Badge>{definition.kind}</Badge>
                      {definition.enabled ? null : <Badge tone="caution">off</Badge>}
                    </div>
                    {definition.description ? (
                      <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">
                        {definition.description}
                      </p>
                    ) : null}
                  </div>
                  <Toggle
                    checked={definition.enabled}
                    label={`Enable ${definition.name}`}
                    onCheckedChange={(next) => void toggle(definition, next)}
                  />
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-rule px-2 py-1">
                  <span className="truncate font-mono text-xs text-faint">
                    {summaryOf(definition)}
                  </span>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button size="sm" variant="quiet" onClick={() => setForm(toForm(definition))}>
                      Edit
                    </Button>
                    <IconButton
                      label={`Delete ${definition.name}`}
                      tone="danger"
                      onClick={() => void remove(definition)}
                    >
                      <Trash2 size={14} strokeWidth={1.75} />
                    </IconButton>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>

      {error ? (
        <p
          role="alert"
          className="rounded-sm border border-danger-rule bg-danger-soft px-2 py-1 font-mono text-xs text-danger"
        >
          {error}
        </p>
      ) : null}

      {form ? (
        <section
          ref={formRef}
          className="flex flex-col rounded-sm border border-rule bg-surface motion-safe:animate-[panel-in_180ms_var(--ease-out-quart)]"
        >
          <div className="flex items-center justify-between gap-2 border-b border-rule px-2 py-1.5">
            <span className="label-micro">{form.originalName === null ? 'New tool' : 'Edit tool'}</span>
            <IconButton label="Close tool form" onClick={() => setForm(null)}>
              <X size={14} strokeWidth={1.75} />
            </IconButton>
          </div>

          <div className="flex flex-col px-2">
            <Row label="Kind">
              <Select
                size="sm"
                value={form.kind}
                onChange={(event) =>
                  setForm({ ...form, kind: event.target.value === 'sandbox-js' ? 'sandbox-js' : 'http' })
                }
              >
                <option value="http">http</option>
                <option value="sandbox-js">sandbox-js</option>
              </Select>
            </Row>
            <Row label="Name">
              <Input size="sm" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </Row>
            <Row label="Description">
              <Input
                size="sm"
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </Row>
            <CodeField
              label="Input schema"
              hint="JSON object"
              language="json"
              value={form.inputSchema}
              onChange={(inputSchema) => setForm({ ...form, inputSchema })}
            />
            {form.kind === 'sandbox-js' ? (
              <CodeField
                label="Source"
                hint="Receives `input` in scope"
                language="javascript"
                value={form.source}
                onChange={(source) => setForm({ ...form, source })}
              />
            ) : (
              <>
                <Row label="Method">
                  <Input size="sm" value={form.method} onChange={(event) => setForm({ ...form, method: event.target.value })} />
                </Row>
                <Row label="URL">
                  <Input size="sm" value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} />
                </Row>
                <CodeField
                  label="Headers"
                  hint="JSON object"
                  language="json"
                  value={form.headers}
                  onChange={(headers) => setForm({ ...form, headers })}
                />
                <CodeField
                  label="Body"
                  language="json"
                  value={form.body}
                  onChange={(body) => setForm({ ...form, body })}
                />
                <Row label="Allowed origins" hint="Comma-separated">
                  <Input
                    size="sm"
                    value={form.allowedOrigins}
                    onChange={(event) => setForm({ ...form, allowedOrigins: event.target.value })}
                  />
                </Row>
              </>
            )}
            <Row label="Timeout (ms)" hint="positive integer">
              <Input
                size="sm"
                value={form.timeoutMs}
                onChange={(event) => setForm({ ...form, timeoutMs: event.target.value })}
              />
            </Row>
          </div>

          <div className="flex gap-1.5 border-t border-rule px-2 py-2">
            <Button size="sm" variant="primary" onClick={() => void saveForm()}>
              Save tool
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setForm(null)}>
              Cancel
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  )
}
