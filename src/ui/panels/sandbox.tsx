import { useState } from 'react'
import { Play, RotateCcw } from 'lucide-react'
import type { RunResult } from '../../sandbox/types'
import type { SandboxLanguage } from '../../sandbox/manager'
import { useSession } from '../../session/session-context'
import { useVaultStore } from '../../vault/store'
import {
  DEFAULT_SANDBOX_JS_TIMEOUT_MS,
  DEFAULT_SANDBOX_PY_TIMEOUT_MS,
} from '../../vault/settings'
import { MonacoEditor } from '../monaco-editor'
import { Button, Input, Row, Select } from '../primitives'

const MAX_TIMEOUT_MS = 600_000

function parseTimeout(text: string): number | null {
  if (text.trim() === '') return null
  const value = Number(text)
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) return null
  return value
}

function OutputBlock({ label, value }: { label: string; value: string }) {
  if (value.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      <span className="label-micro">{label}</span>
      <pre className="max-h-40 overflow-auto rounded-sm border border-rule bg-paper-sunk p-1.5 font-mono text-xs text-ink wrap-break-word whitespace-pre-wrap">
        {value}
      </pre>
    </div>
  )
}

export function SandboxPanel() {
  const session = useSession()
  const sandbox = useVaultStore((s) => s.settings?.sandbox)
  const update = useVaultStore((s) => s.update)
  const manager = session.sandbox()
  const availability = manager?.availability() ?? { js: false, python: false }

  const [jsTimeout, setJsTimeout] = useState(String(sandbox?.jsTimeoutMs ?? DEFAULT_SANDBOX_JS_TIMEOUT_MS))
  const [pyTimeout, setPyTimeout] = useState(String(sandbox?.pyTimeoutMs ?? DEFAULT_SANDBOX_PY_TIMEOUT_MS))
  const [language, setLanguage] = useState<SandboxLanguage>('js')
  const [source, setSource] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<RunResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Per-session only: component state, so it resets on unmount and on vault
  // lock (the shell unmounts) and is never persisted to settings.
  const [workspaceAccess, setWorkspaceAccess] = useState(false)

  const enabled = sandbox?.enabled ?? true

  const persistTimeout = async (kind: 'js' | 'py') => {
    const text = kind === 'js' ? jsTimeout : pyTimeout
    const value = parseTimeout(text)
    if (value === null) {
      setError('Timeouts must be positive integers up to 600000 ms.')
      return
    }
    setError(null)
    try {
      await update({ sandbox: kind === 'js' ? { jsTimeoutMs: value } : { pyTimeoutMs: value } })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The timeout could not be saved.')
    }
  }

  const run = async () => {
    if (!manager) return
    setRunning(true)
    setError(null)
    try {
      const outcome = await manager.run(language, source, { workspace: workspaceAccess })
      setResult(outcome)
      if (outcome.error) setError(outcome.error)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="flex flex-col p-2">
      <Row label="Enabled" hint="Gates the model's run_js and run_python tools.">
        <label className="flex items-center gap-2 py-1 text-sm text-ink">
          <input
            type="checkbox"
            checked={enabled}
            aria-label="Enable sandbox"
            onChange={(event) => void update({ sandbox: { enabled: event.target.checked } })}
          />
          {enabled ? 'Enabled' : 'Disabled'}
        </label>
      </Row>

      <Row label="Runner availability">
        <span className="font-mono text-xs text-muted">
          JS {availability.js ? 'available' : 'unavailable'} · Python{' '}
          {availability.python ? 'available' : 'unavailable'}
          {availability.reason ? ` · ${availability.reason}` : ''}
        </span>
      </Row>

      <Row label="Session" hint="Terminates the warm scratchpad workers; the next run starts clean.">
        <Button
          size="sm"
          disabled={running || !manager}
          onClick={() => {
            manager?.reset(undefined, 'console')
            setResult(null)
            setError(null)
          }}
          icon={<RotateCcw size={14} strokeWidth={1.75} />}
        >
          Reset session
        </Button>
      </Row>

      <Row label="JS timeout (ms)">
        <Input
          size="sm"
          value={jsTimeout}
          onChange={(event) => setJsTimeout(event.target.value)}
          onBlur={() => void persistTimeout('js')}
        />
      </Row>
      <Row label="Python timeout (ms)">
        <Input
          size="sm"
          value={pyTimeout}
          onChange={(event) => setPyTimeout(event.target.value)}
          onBlur={() => void persistTimeout('py')}
        />
      </Row>

      {error ? (
        <p role="alert" className="pt-2 font-mono text-xs text-danger">
          {error}
        </p>
      ) : null}

      <div className="mt-1 flex flex-col gap-2 border-t border-rule pt-2">
        <div className="flex items-center justify-between gap-2">
          <span className="label-micro">Scratchpad</span>
          <div className="flex items-center gap-1.5">
            <span className="w-32 shrink-0">
              <Select
                size="sm"
                aria-label="Scratchpad language"
                value={language}
                onChange={(event) => setLanguage(event.target.value === 'python' ? 'python' : 'js')}
              >
                <option value="js">JavaScript</option>
                <option value="python">Python</option>
              </Select>
            </span>
            <Button
              size="sm"
              variant="primary"
              disabled={!enabled || running || !manager}
              onClick={() => void run()}
              icon={<Play size={14} strokeWidth={1.75} />}
            >
              {running ? 'Running…' : 'Run'}
            </Button>
          </div>
        </div>

        <p className="text-xs text-faint">
          {workspaceAccess
            ? 'Workspace access is ON for this session: the console can read and write the folder.'
            : 'File-less mode: the console cannot reach the workspace folder.'}
        </p>

        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={workspaceAccess}
            aria-label="Grant scratchpad workspace access for this session"
            onChange={(event) => setWorkspaceAccess(event.target.checked)}
          />
          Workspace access (this session only)
        </label>

        <div className="h-48 overflow-hidden rounded-sm border border-rule-strong bg-surface">
          <MonacoEditor
            value={source}
            onChange={setSource}
            language={language === 'python' ? 'python' : 'javascript'}
            ariaLabel="Scratchpad source"
            className="h-full"
          />
        </div>

        {result ? (
          <div className="flex flex-col gap-2">
            <OutputBlock label="stdout" value={result.stdout} />
            <OutputBlock label="stderr" value={result.stderr} />
            <OutputBlock label="result" value={result.result ?? ''} />
            <OutputBlock label="error" value={result.error ?? ''} />
          </div>
        ) : (
          <p className="text-xs text-faint">No run yet.</p>
        )}
      </div>
    </div>
  )
}
