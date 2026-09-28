import { useState } from 'react'
import { Plug, Plus, Trash2 } from 'lucide-react'
import { useStore } from 'zustand'
import { SecretField } from '../../ai/secret-field'
import type { McpConnectionState, McpServerView } from '../../mcp/manager'
import { mcpToolName } from '../../mcp/tool-bridge'
import {
  MCP_DEFAULT_TIMEOUT_MS,
  MCP_TRANSPORT_KINDS,
  newMcpServerId,
} from '../../mcp/types'
import type { McpAuth, McpServerConfig, McpTransportKind } from '../../mcp/types'
import { useSession } from '../../session/session-context'
import type { BadgeTone } from '../primitives'
import {
  Badge,
  Button,
  EmptyState,
  Field,
  IconButton,
  Input,
  PanelSection,
  Select,
  Toggle,
} from '../primitives'

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

type AuthKind = McpAuth['kind']

interface HeaderRow {
  key: number
  name: string
  value: string
}

interface FormState {
  id: string | null
  name: string
  url: string
  transport: McpTransportKind
  proxyUrl: string
  authKind: AuthKind
  headers: HeaderRow[]
  clientId: string
  clientSecret: string
  scopes: string
  timeoutSeconds: string
  enabled: boolean
  disabledTools: string[]
}

const TRANSPORT_LABELS: Record<McpTransportKind, string> = {
  auto: 'Auto',
  'streamable-http': 'Streamable HTTP',
  sse: 'SSE (legacy)',
}

const STATE_LABELS: Record<McpConnectionState, string> = {
  idle: 'off',
  connecting: 'connecting',
  ready: 'connected',
  'needs-auth': 'sign in',
  error: 'error',
}

const STATE_TONES: Record<McpConnectionState, BadgeTone> = {
  idle: 'neutral',
  connecting: 'accent',
  ready: 'positive',
  'needs-auth': 'caution',
  error: 'danger',
}

let headerKey = 0

function headerRow(name = '', value = ''): HeaderRow {
  headerKey += 1
  return { key: headerKey, name, value }
}

function emptyForm(): FormState {
  return {
    id: null,
    name: '',
    url: '',
    transport: 'auto',
    proxyUrl: '',
    authKind: 'none',
    headers: [headerRow('Authorization', '')],
    clientId: '',
    clientSecret: '',
    scopes: '',
    timeoutSeconds: String(MCP_DEFAULT_TIMEOUT_MS / 1000),
    enabled: true,
    disabledTools: [],
  }
}

function formFor(config: McpServerConfig): FormState {
  const auth = config.auth
  return {
    id: config.id,
    name: config.name,
    url: config.url,
    transport: config.transport,
    proxyUrl: config.proxyUrl ?? '',
    authKind: auth.kind,
    headers:
      auth.kind === 'headers'
        ? Object.entries(auth.headers).map(([name, value]) => headerRow(name, value))
        : [headerRow('Authorization', '')],
    clientId: auth.kind === 'oauth' ? (auth.clientId ?? '') : '',
    clientSecret: auth.kind === 'oauth' ? (auth.clientSecret ?? '') : '',
    scopes: auth.kind === 'oauth' ? (auth.scopes ?? '') : '',
    timeoutSeconds: String(config.timeoutMs / 1000),
    enabled: config.enabled,
    disabledTools: config.disabledTools,
  }
}

function configFrom(form: FormState): McpServerConfig {
  let auth: McpAuth = { kind: 'none' }
  if (form.authKind === 'headers') {
    const headers: Record<string, string> = {}
    for (const row of form.headers) {
      if (row.name.trim().length === 0 && row.value.length === 0) continue
      headers[row.name.trim()] = row.value
    }
    auth = { kind: 'headers', headers }
  } else if (form.authKind === 'oauth') {
    auth = {
      kind: 'oauth',
      ...(form.clientId.trim() ? { clientId: form.clientId.trim() } : {}),
      ...(form.clientSecret.trim() ? { clientSecret: form.clientSecret.trim() } : {}),
      ...(form.scopes.trim() ? { scopes: form.scopes.trim() } : {}),
    }
  }
  const seconds = Number(form.timeoutSeconds)
  return {
    id: form.id ?? newMcpServerId(),
    name: form.name,
    url: form.url,
    transport: form.transport,
    ...(form.proxyUrl.trim() ? { proxyUrl: form.proxyUrl.trim() } : {}),
    auth,
    enabled: form.enabled,
    disabledTools: form.disabledTools,
    timeoutMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : Number.NaN,
  }
}

function ServerForm({
  form,
  error,
  onChange,
  onSave,
  onCancel,
}: {
  form: FormState
  error: string | null
  onChange(next: FormState): void
  onSave(): void
  onCancel(): void
}) {
  const setHeader = (key: number, patch: Partial<HeaderRow>) =>
    onChange({
      ...form,
      headers: form.headers.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    })
  return (
    <div className="flex flex-col gap-2 rounded-sm border border-rule bg-surface p-2">
      <span className="label-micro">{form.id ? 'Editing server' : 'New MCP server'}</span>
      <Field label="Name">
        <Input
          size="sm"
          aria-label="Server name"
          value={form.name}
          onChange={(event) => onChange({ ...form, name: event.target.value })}
        />
      </Field>
      <Field label="URL">
        <Input
          size="sm"
          aria-label="Server URL"
          placeholder="https://example.com/mcp"
          value={form.url}
          onChange={(event) => onChange({ ...form, url: event.target.value })}
        />
      </Field>
      <Field label="Transport">
        <Select
          size="sm"
          aria-label="Transport"
          value={form.transport}
          onChange={(event) => onChange({ ...form, transport: event.target.value as McpTransportKind })}
        >
          {MCP_TRANSPORT_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {TRANSPORT_LABELS[kind]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Proxy URL · optional">
        <Input
          size="sm"
          aria-label="Proxy URL"
          placeholder="https://your-proxy.example.com/"
          value={form.proxyUrl}
          onChange={(event) => onChange({ ...form, proxyUrl: event.target.value })}
        />
      </Field>
      {form.proxyUrl.trim().length > 0 ? (
        <p role="note" className="rounded-sm border border-caution-rule bg-caution-soft px-2 py-1.5 text-xs text-caution">
          Every request, including tokens and headers, goes through this proxy. Use only a proxy you run
          or trust. Requests are sent to the proxy URL followed by the server URL.
        </p>
      ) : null}
      <Field label="Authentication">
        <Select
          size="sm"
          aria-label="Authentication"
          value={form.authKind}
          onChange={(event) => onChange({ ...form, authKind: event.target.value as AuthKind })}
        >
          <option value="none">None</option>
          <option value="headers">Headers</option>
          <option value="oauth">OAuth</option>
        </Select>
      </Field>
      {form.authKind === 'headers' ? (
        <div className="flex flex-col gap-1.5">
          {form.headers.map((row, index) => (
            <div key={row.key} className="flex items-start gap-1.5">
              <div className="w-2/5 shrink-0">
                <Input
                  size="sm"
                  aria-label={`Header ${index + 1} name`}
                  value={row.name}
                  onChange={(event) => setHeader(row.key, { name: event.target.value })}
                />
              </div>
              <div className="min-w-0 flex-1">
                <SecretField
                  name={`mcp-header-${row.key}`}
                  storedValue={row.value}
                  placeholder="Value"
                  onChange={(value) => setHeader(row.key, { value })}
                />
              </div>
              <IconButton
                label={`Remove header ${index + 1}`}
                tone="danger"
                onClick={() =>
                  onChange({ ...form, headers: form.headers.filter((entry) => entry.key !== row.key) })
                }
              >
                <Trash2 size={14} strokeWidth={1.75} />
              </IconButton>
            </div>
          ))}
          <Button
            size="sm"
            variant="quiet"
            icon={<Plus size={14} strokeWidth={1.75} />}
            onClick={() => onChange({ ...form, headers: [...form.headers, headerRow()] })}
          >
            Add header
          </Button>
        </div>
      ) : null}
      {form.authKind === 'oauth' ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs leading-relaxed text-faint">
            Leave the client ID empty to register this app with the server automatically. Pre-registered
            clients must allow the redirect URL {`${window.location.origin}${window.location.pathname}?mcp-oauth=callback`}.
          </p>
          <Field label="Client ID · optional">
            <Input
              size="sm"
              aria-label="OAuth client ID"
              value={form.clientId}
              onChange={(event) => onChange({ ...form, clientId: event.target.value })}
            />
          </Field>
          <Field label="Client secret · optional">
            <SecretField
              name="mcp-oauth-secret"
              storedValue={form.clientSecret}
              placeholder="Only for confidential clients"
              onChange={(clientSecret) => onChange({ ...form, clientSecret })}
            />
          </Field>
          <Field label="Scopes · optional">
            <Input
              size="sm"
              aria-label="OAuth scopes"
              value={form.scopes}
              onChange={(event) => onChange({ ...form, scopes: event.target.value })}
            />
          </Field>
        </div>
      ) : null}
      <Field label="Timeout · seconds">
        <Input
          size="sm"
          aria-label="Timeout in seconds"
          inputMode="numeric"
          value={form.timeoutSeconds}
          onChange={(event) => onChange({ ...form, timeoutSeconds: event.target.value })}
        />
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

function counts(view: McpServerView): string {
  const { tools, prompts, resources } = view.catalog
  return `${tools.length} tools · ${prompts.length} prompts · ${resources.length} resources`
}

function ServerRow({
  view,
  expanded,
  pendingDelete,
  onToggle,
  onEdit,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
  onAction,
}: {
  view: McpServerView
  expanded: boolean
  pendingDelete: boolean
  onToggle(): void
  onEdit(): void
  onDelete(): void
  onConfirmDelete(): void
  onCancelDelete(): void
  onAction(action: (id: string) => Promise<void>): void
}) {
  const session = useSession()
  const { config } = view
  const oauth = config.auth.kind === 'oauth'
  const disabled = new Set(config.disabledTools)
  return (
    <li className="rounded-sm border border-rule bg-surface" data-mcp-server={config.id}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 p-2 text-left"
      >
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{config.name}</span>
        <Badge size="sm" tone={STATE_TONES[view.state]}>
          {STATE_LABELS[view.state]}
        </Badge>
      </button>
      {expanded ? (
        <div className="flex flex-col gap-2 border-t border-rule p-2">
          <span className="truncate font-mono text-xs text-faint" title={config.url}>
            {config.url}
          </span>
          {view.state === 'ready' ? <span className="text-xs text-muted">{counts(view)}</span> : null}
          {view.reason ? (
            <p
              role={view.state === 'error' ? 'alert' : 'status'}
              className={`text-xs leading-relaxed ${view.state === 'error' ? 'text-danger' : 'text-muted'}`}
            >
              {view.reason}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted">Enabled</span>
              <Toggle
                checked={config.enabled}
                label={`Enable ${config.name}`}
                onCheckedChange={(enabled) =>
                  onAction(() => session.mcp.saveServer({ ...config, enabled }).then(() => undefined))
                }
              />
            </div>
            {config.enabled && view.state !== 'connecting' ? (
              <Button size="sm" variant="secondary" onClick={() => onAction((id) => session.mcp.connect(id))}>
                {view.state === 'ready' ? 'Reconnect' : 'Connect'}
              </Button>
            ) : null}
            {oauth && config.enabled && view.state !== 'ready' ? (
              <Button size="sm" variant="primary" onClick={() => onAction((id) => session.mcp.signIn(id))}>
                Sign in
              </Button>
            ) : null}
            {oauth ? (
              <Button size="sm" variant="quiet" onClick={() => onAction((id) => session.mcp.signOut(id))}>
                Sign out
              </Button>
            ) : null}
          </div>
          {view.skippedTools.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="label-micro">Not available to the model</span>
              <ul className="flex flex-col gap-0.5">
                {view.skippedTools.map((entry) => (
                  <li key={entry.name} className="text-xs text-caution">
                    <span className="font-mono">{entry.name}</span>: {entry.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {view.catalog.tools.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="label-micro">Tools</span>
              <ul className="flex flex-col gap-0.5">
                {view.catalog.tools.map((tool) => (
                  <li key={tool.name} className="flex items-center gap-1.5">
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-xs text-ink"
                      title={tool.description ?? tool.name}
                    >
                      {mcpToolName(config.name, tool.name)}
                    </span>
                    <Toggle
                      checked={!disabled.has(tool.name)}
                      label={`Enable tool ${tool.name}`}
                      onCheckedChange={(enabled) =>
                        onAction((id) => session.mcp.setToolEnabled(id, tool.name, enabled))
                      }
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {view.catalog.prompts.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="label-micro">Prompts</span>
              <p className="text-xs text-muted">
                {view.catalog.prompts.map((prompt) => prompt.name).join(', ')}
              </p>
            </div>
          ) : null}
          {view.catalog.resources.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="label-micro">Resources</span>
              <p className="text-xs text-muted">
                {view.catalog.resources.map((resource) => resource.name).join(', ')}
              </p>
            </div>
          ) : null}
          {pendingDelete ? (
            <div
              role="alertdialog"
              aria-label={`Remove ${config.name}`}
              className="flex items-center gap-1.5 rounded-sm border border-danger-rule bg-danger-soft px-2 py-1.5"
            >
              <span className="min-w-0 flex-1 truncate text-xs text-ink">Remove “{config.name}”?</span>
              <Button size="sm" variant="danger" onClick={onConfirmDelete}>
                Remove
              </Button>
              <Button size="sm" variant="quiet" onClick={onCancelDelete}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-end gap-0.5">
              <Button size="sm" variant="quiet" onClick={onEdit}>
                Edit
              </Button>
              <IconButton label={`Remove ${config.name}`} tone="danger" onClick={onDelete}>
                <Trash2 size={14} strokeWidth={1.75} />
              </IconButton>
            </div>
          )}
        </div>
      ) : null}
    </li>
  )
}

export function McpPanel() {
  const session = useSession()
  const state = useStore(session.mcp.store)
  const views = state.order
    .map((id) => state.servers[id])
    .filter((view): view is McpServerView => view !== undefined)
  const [form, setForm] = useState<FormState | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const save = async () => {
    if (!form) return
    try {
      const saved = await session.mcp.saveServer(configFrom(form))
      setForm(null)
      setFormError(null)
      setExpanded(saved.config.id)
    } catch (error) {
      setFormError(messageOf(error))
    }
  }

  const run = (id: string) => (action: (serverId: string) => Promise<void>) => {
    setActionError(null)
    action(id).catch((error: unknown) => setActionError(messageOf(error)))
  }

  return (
    <div className="flex flex-col gap-3 p-2">
      <PanelSection
        label="MCP servers"
        count={views.length}
        hint="Remote MCP servers add tools, prompts, and resources. Their tools run without asking in Editing mode (set Ask or Deny per tool in Approvals), and their content is treated as untrusted."
        action={
          form === null ? (
            <Button
              size="sm"
              variant="quiet"
              icon={<Plus size={14} strokeWidth={1.75} />}
              onClick={() => {
                setForm(emptyForm())
                setFormError(null)
              }}
            >
              Add
            </Button>
          ) : null
        }
      >
        {state.error ? (
          <p role="alert" className="font-mono text-xs text-danger">
            {state.error}
          </p>
        ) : null}
        {actionError ? (
          <p role="alert" className="font-mono text-xs text-danger">
            {actionError}
          </p>
        ) : null}
        {form !== null ? (
          <ServerForm
            form={form}
            error={formError}
            onChange={setForm}
            onSave={() => void save()}
            onCancel={() => {
              setForm(null)
              setFormError(null)
            }}
          />
        ) : null}
        {views.length === 0 && form === null ? (
          <EmptyState
            icon={<Plug size={18} strokeWidth={1.75} />}
            title="No MCP servers yet."
            hint="Add a server by its Streamable HTTP or SSE URL. Stdio servers need a bridge that exposes them over HTTP."
          />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {views.map((view) => (
              <ServerRow
                key={view.config.id}
                view={view}
                expanded={expanded === view.config.id}
                pendingDelete={pendingDelete === view.config.id}
                onToggle={() => setExpanded((current) => (current === view.config.id ? null : view.config.id))}
                onEdit={() => {
                  setForm(formFor(view.config))
                  setFormError(null)
                }}
                onDelete={() => setPendingDelete(view.config.id)}
                onCancelDelete={() => setPendingDelete(null)}
                onConfirmDelete={() => {
                  setPendingDelete(null)
                  run(view.config.id)((id) => session.mcp.removeServer(id))
                }}
                onAction={run(view.config.id)}
              />
            ))}
          </ul>
        )}
      </PanelSection>
    </div>
  )
}
