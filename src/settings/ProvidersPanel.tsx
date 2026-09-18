import { useMemo, useRef, useState } from 'react'
import { useVaultStore } from '../vault/store'
import type { ProviderConfig, Settings } from '../vault/settings'
import { MAX_MODELS_PER_PROVIDER, MAX_PROVIDERS, validateProvider } from '../ai/providers'
import type { ProviderValidationErrors } from '../ai/providers'
import { createLLM } from '../ai/llm'
import { SecretField } from '../ai/secret-field'
import { generateText } from 'ai'

function emptyProvider(): ProviderConfig {
  return {
    id: `provider-${Date.now().toString(36)}`,
    label: '',
    kind: 'openai-compatible',
    baseURL: '',
    apiKey: '',
    models: [],
    defaultModel: '',
  }
}

type ConnectionState = { status: 'idle' | 'testing' | 'ok' | 'error'; message?: string }

function ProviderCard({
  provider,
  onSave,
  onDelete,
}: {
  provider: ProviderConfig
  onSave: (next: ProviderConfig) => Promise<void>
  onDelete: () => Promise<void>
}) {
  const [draft, setDraft] = useState(provider)
  const [errors, setErrors] = useState<ProviderValidationErrors>({})
  const [connection, setConnection] = useState<ConnectionState>({ status: 'idle' })
  const [modelsText, setModelsText] = useState(provider.models.join('\n'))

  const patch = (next: Partial<ProviderConfig>) => setDraft((prev) => ({ ...prev, ...next }))

  const commitModels = () => {
    const models = modelsText
      .split(/[\n,]/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, MAX_MODELS_PER_PROVIDER)
    patch({ models })
  }

  const save = async () => {
    const next = { ...draft, models: draft.models }
    const found = validateProvider(next)
    setErrors(found)
    if (Object.keys(found).length > 0) return
    await onSave(next)
  }

  const testConnection = async () => {
    const found = validateProvider(draft)
    setErrors(found)
    if (Object.keys(found).length > 0) return
    setConnection({ status: 'testing' })
    try {
      const settings = useVaultStore.getState().settings
      if (!settings) throw new Error('Vault is locked.')
      const model = createLLM({ ...settings, providers: [draft] }, draft.id)
      await generateText({ model, prompt: 'Reply with the single word: ok' })
      setConnection({ status: 'ok', message: 'Connection succeeded.' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed.'
      setConnection({ status: 'error', message: message.replaceAll(draft.apiKey, '***') })
    }
  }

  return (
    <article className="mb-4 rounded border border-[var(--border)] p-4 text-left">
      <div className="grid gap-3">
        <label className="grid gap-1 text-xs">
          Label
          <input
            value={draft.label}
            onChange={(event) => patch({ label: event.target.value })}
            className="rounded border border-[var(--border)] bg-transparent px-3 py-2 text-sm"
          />
          {errors.label ? <span className="text-red-500">{errors.label}</span> : null}
        </label>
        <label className="grid gap-1 text-xs">
          Base URL
          <input
            value={draft.baseURL}
            onChange={(event) => patch({ baseURL: event.target.value })}
            placeholder="https://api.example.com/v1"
            className="rounded border border-[var(--border)] bg-transparent px-3 py-2 font-mono text-sm"
          />
          {errors.baseURL ? <span className="text-red-500">{errors.baseURL}</span> : null}
        </label>
        <div className="grid gap-1 text-xs">
          API key
          <SecretField
            name={`provider-${draft.id}-apiKey`}
            storedValue={draft.apiKey}
            onChange={(value) => patch({ apiKey: value })}
          />
          {errors.apiKey ? <span className="text-red-500">{errors.apiKey}</span> : null}
        </div>
        <label className="grid gap-1 text-xs">
          Models (one per line, max {MAX_MODELS_PER_PROVIDER})
          <textarea
            value={modelsText}
            onChange={(event) => setModelsText(event.target.value)}
            onBlur={commitModels}
            rows={3}
            className="rounded border border-[var(--border)] bg-transparent px-3 py-2 font-mono text-sm"
          />
          {errors.models ? <span className="text-red-500">{errors.models}</span> : null}
        </label>
        <label className="grid gap-1 text-xs">
          Default model
          <select
            value={draft.defaultModel}
            onChange={(event) => patch({ defaultModel: event.target.value })}
            className="rounded border border-[var(--border)] bg-transparent px-3 py-2 text-sm"
          >
            <option value="">Select a model…</option>
            {draft.models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
          {errors.defaultModel ? <span className="text-red-500">{errors.defaultModel}</span> : null}
        </label>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => void save()} className="rounded bg-[var(--accent)] px-3 py-1 text-sm text-white">
          Save provider
        </button>
        <button type="button" onClick={() => void testConnection()} className="rounded border border-[var(--border)] px-3 py-1 text-sm">
          {connection.status === 'testing' ? 'Testing…' : 'Test connection'}
        </button>
        <button type="button" onClick={() => void onDelete()} className="rounded border border-[var(--border)] px-3 py-1 text-sm">
          Delete
        </button>
        {connection.message ? (
          <span className={connection.status === 'ok' ? 'text-sm text-green-600' : 'text-sm text-red-500'}>
            {connection.message}
          </span>
        ) : null}
      </div>
    </article>
  )
}

function TypeSafeForm({ settings }: { settings: Settings }) {
  const update = useVaultStore((s) => s.update)
  const [draft, setDraft] = useState(settings.typesafe)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const persist = (next: typeof draft) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      // A lock may win the race with this debounced write; that is benign and
      // must not surface as a vault failure.
      void update({ typesafe: next }).catch(() => undefined)
    }, 400)
  }

  const patch = (next: Partial<typeof draft>) => {
    setDraft((prev) => {
      const merged = { ...prev, ...next }
      persist(merged)
      return merged
    })
  }

  return (
    <section className="mb-6 rounded border border-[var(--border)] p-4 text-left">
      <h2 className="mb-3 text-lg">TypeSafe</h2>
      <div className="grid gap-3">
        <div className="grid gap-1 text-xs">
          API key
          <SecretField
            name="typesafe-apiKey"
            storedValue={draft.apiKey}
            onChange={(value) => patch({ apiKey: value })}
          />
        </div>
        <label className="grid gap-1 text-xs">
          Model
          <input
            value={draft.model}
            onChange={(event) => patch({ model: event.target.value })}
            className="rounded border border-[var(--border)] bg-transparent px-3 py-2 text-sm"
          />
        </label>
        <label className="grid gap-1 text-xs">
          Base URL override (optional)
          <input
            value={draft.baseURL ?? ''}
            onChange={(event) => patch({ baseURL: event.target.value })}
            placeholder="https://api.typesafe.ai"
            className="rounded border border-[var(--border)] bg-transparent px-3 py-2 font-mono text-sm"
          />
        </label>
      </div>
    </section>
  )
}

export function ProvidersPanel() {
  const settings = useVaultStore((s) => s.settings)
  const update = useVaultStore((s) => s.update)
  const [adding, setAdding] = useState(false)
  const [newProvider, setNewProvider] = useState<ProviderConfig | null>(null)

  const providers = useMemo(() => settings?.providers ?? [], [settings])

  if (!settings) return null

  const startAdd = () => {
    if (adding) {
      setAdding(false)
      setNewProvider(null)
      return
    }
    if (providers.length >= MAX_PROVIDERS) return
    setNewProvider(emptyProvider())
    setAdding(true)
  }

  const saveProvider = async (next: ProviderConfig) => {
    const exists = providers.some((provider) => provider.id === next.id)
    const list = exists
      ? providers.map((provider) => (provider.id === next.id ? next : provider))
      : [...providers, next]
    await update({ providers: list })
    setAdding(false)
    setNewProvider(null)
  }

  const deleteProvider = async (id: string) => {
    await update({ providers: providers.filter((provider) => provider.id !== id) })
  }

  return (
    <section className="text-left">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-lg">LLM Providers</h2>
        <button
          type="button"
          onClick={startAdd}
          className="rounded border border-[var(--border)] px-3 py-1 text-sm"
        >
          {adding ? 'Cancel' : 'Add provider'}
        </button>
      </header>
      {adding && newProvider ? (
        <ProviderCard
          provider={newProvider}
          onSave={saveProvider}
          onDelete={async () => {
            setAdding(false)
            setNewProvider(null)
          }}
        />
      ) : null}
      {providers.map((provider) => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          onSave={saveProvider}
          onDelete={() => deleteProvider(provider.id)}
        />
      ))}
      {providers.length === 0 && !adding ? (
        <p className="text-sm">No providers configured yet.</p>
      ) : null}
      <TypeSafeForm settings={settings} />
    </section>
  )
}
