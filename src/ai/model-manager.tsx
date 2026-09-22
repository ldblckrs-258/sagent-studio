import { useMemo, useState } from 'react'
import {
  CircleCheck,
  CircleX,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  TriangleAlert,
  X,
} from 'lucide-react'
import type { ModelCaps, ModelConfig, ProviderConfig } from '../vault/settings'
import { MAX_MODELS_PER_PROVIDER } from '../vault/settings'
import { fetchModels, mergeModels } from './model-catalog'

type DiscoveryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; added: number; found: number; truncated: number }
  | { status: 'error'; message: string }

function sortModels(models: readonly ModelConfig[]): ModelConfig[] {
  return [...models].sort((a, b) => a.id.localeCompare(b.id))
}

function displayName(model: ModelConfig): string {
  return model.name ?? model.id
}

/**
 * Merges a caps patch and drops keys the user cleared, so an unset field stays
 * absent (unknown) instead of becoming an explicit `undefined` in the vault.
 */
function applyCaps(model: ModelConfig, patch: Partial<ModelCaps>): ModelConfig {
  const merged: Record<string, unknown> = { ...(model.caps ?? {}), ...patch }
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key]
  }
  const next: ModelConfig = { ...model }
  if (Object.keys(merged).length > 0) next.caps = merged as ModelCaps
  else delete next.caps
  return next
}

const CAP_FLAGS: { key: 'vision' | 'search' | 'reasoning' | 'embedding'; label: string; hint: string }[] = [
  { key: 'embedding', label: 'Embedding', hint: 'Usable as an embedding model in the Documents panel.' },
  { key: 'vision', label: 'Vision', hint: 'Accepts image attachments.' },
  { key: 'search', label: 'Search', hint: 'Provider-side search.' },
  { key: 'reasoning', label: 'Reasoning', hint: 'Supports a reasoning mode.' },
]

const CAP_INPUT =
  'min-h-7 w-full rounded-sm border border-rule-strong bg-surface px-2 font-mono text-xs transition-colors duration-150 ease-out-quart hover:border-muted focus:border-accent'

function ModelCapsEditor({
  model,
  onChange,
}: {
  model: ModelConfig
  onChange: (next: ModelConfig) => void
}) {
  const caps = model.caps ?? {}
  const [contextText, setContextText] = useState(caps.contextWindow?.toString() ?? '')
  const [outputText, setOutputText] = useState(caps.maxOutput?.toString() ?? '')

  const commitNumber = (key: 'contextWindow' | 'maxOutput', text: string) => {
    const trimmed = text.trim()
    if (trimmed === '') {
      onChange(applyCaps(model, { [key]: undefined }))
      return
    }
    const value = Number(trimmed)
    if (Number.isInteger(value) && value > 0) {
      onChange(applyCaps(model, { [key]: value }))
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-rule px-1 pb-2 pt-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {CAP_FLAGS.map((flag) => (
          <label
            key={flag.key}
            title={flag.hint}
            className="flex min-h-6 cursor-pointer items-center gap-1.5 text-xs text-ink"
          >
            <input
              type="checkbox"
              checked={caps[flag.key] === true}
              onChange={(event) =>
                onChange(applyCaps(model, { [flag.key]: event.target.checked }))
              }
              className="size-3.5 accent-[var(--color-accent)]"
            />
            {flag.label}
          </label>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="label-micro">Context window</span>
          <input
            value={contextText}
            inputMode="numeric"
            spellCheck={false}
            placeholder="tokens"
            aria-label={`Context window for ${model.id}`}
            onChange={(event) => {
              setContextText(event.target.value)
              commitNumber('contextWindow', event.target.value)
            }}
            className={CAP_INPUT}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="label-micro">Max output</span>
          <input
            value={outputText}
            inputMode="numeric"
            spellCheck={false}
            placeholder="tokens"
            aria-label={`Max output for ${model.id}`}
            onChange={(event) => {
              setOutputText(event.target.value)
              commitNumber('maxOutput', event.target.value)
            }}
            className={CAP_INPUT}
          />
        </label>
      </div>
      <p className="text-xs text-faint">
        Context window drives the auto-compact cap; vision gates image attachments; embedding
        models appear in the Documents panel's model picker.
      </p>
    </div>
  )
}

export function ModelManager({
  provider,
  models,
  defaultModel,
  onModelsChange,
  onDefaultModelChange,
}: {
  provider: ProviderConfig
  models: ModelConfig[]
  defaultModel: string
  onModelsChange: (models: ModelConfig[]) => void
  onDefaultModelChange: (model: string) => void
}) {
  const [discovery, setDiscovery] = useState<DiscoveryState>({ status: 'idle' })
  const [query, setQuery] = useState('')
  const [manual, setManual] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const atCap = models.length >= MAX_MODELS_PER_PROVIDER

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return models
    return models.filter(
      (model) =>
        model.id.toLowerCase().includes(needle) ||
        model.name?.toLowerCase().includes(needle),
    )
  }, [models, query])

  const discover = async () => {
    setDiscovery({ status: 'loading' })
    try {
      const found = await fetchModels(provider)
      const merged = mergeModels(models, found)
      onModelsChange(merged.models)
      if (!defaultModel && merged.models.length > 0) {
        onDefaultModelChange(merged.models[0].id)
      }
      setDiscovery({
        status: 'ok',
        added: merged.added,
        found: found.length,
        truncated: merged.truncated,
      })
    } catch (error) {
      setDiscovery({
        status: 'error',
        message: error instanceof Error ? error.message : 'Model discovery failed.',
      })
    }
  }

  const addManual = () => {
    const id = manual.trim()
    if (!id) return
    if (models.some((model) => model.id === id)) {
      setManual('')
      return
    }
    if (atCap) return
    onModelsChange(sortModels([...models, { id }]))
    if (!defaultModel) onDefaultModelChange(id)
    setManual('')
  }

  const updateModel = (next: ModelConfig) => {
    onModelsChange(models.map((model) => (model.id === next.id ? next : model)))
  }

  const remove = (id: string) => {
    const next = models.filter((model) => model.id !== id)
    onModelsChange(next)
    if (defaultModel === id) onDefaultModelChange(next[0]?.id ?? '')
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void discover()}
          disabled={discovery.status === 'loading'}
          className="relative inline-flex min-h-8 items-center gap-1.5 rounded-sm border border-rule-strong px-2.5 text-sm text-ink transition-colors duration-150 ease-out-quart after:absolute after:-inset-1 after:content-[''] hover:bg-paper-sunk active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45"
        >
          {discovery.status === 'loading' ? (
            <LoaderCircle size={14} strokeWidth={2} aria-hidden="true" className="animate-spin" />
          ) : (
            <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
          )}
          {discovery.status === 'loading' ? 'Fetching' : 'Fetch from provider'}
        </button>
        <span className="numeric font-mono text-xs text-faint">
          {models.length} / {MAX_MODELS_PER_PROVIDER} selected
        </span>
      </div>

      {discovery.status === 'ok' ? (
        <p role="status" className="flex flex-wrap items-center gap-2 font-mono text-xs text-positive">
          <CircleCheck size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>
            Found {discovery.found}. Added {discovery.added}.
          </span>
          {discovery.truncated > 0 ? (
            <span className="text-caution">
              {discovery.truncated} skipped at the {MAX_MODELS_PER_PROVIDER} model cap.
            </span>
          ) : null}
        </p>
      ) : null}

      {discovery.status === 'error' ? (
        <p role="alert" className="flex items-start gap-2 font-mono text-xs text-danger">
          <CircleX size={14} strokeWidth={1.75} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>
            {discovery.message}{' '}
            <span className="text-muted">You can still add model IDs by hand above.</span>
          </span>
        </p>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault()
          addManual()
        }}
        className="flex gap-1.5"
      >
        <div className="relative min-w-0 flex-1">
          <input
            value={manual}
            spellCheck={false}
            placeholder="Add a model ID"
            aria-label="Add a model ID"
            disabled={atCap}
            onChange={(event) => setManual(event.target.value)}
            className="min-h-8 w-full rounded-sm border border-rule-strong bg-surface py-1 pl-2 pr-2 font-mono text-sm transition-colors duration-150 ease-out-quart placeholder:text-faint hover:border-muted focus:border-accent disabled:opacity-45"
          />
        </div>
        <button
          type="submit"
          disabled={atCap || !manual.trim()}
          className="relative inline-flex min-h-8 items-center gap-1.5 rounded-sm border border-rule-strong px-2.5 text-sm transition-colors duration-150 ease-out-quart after:absolute after:-inset-1 after:content-[''] hover:bg-paper-sunk active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45"
        >
          <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
          Add
        </button>
      </form>

      {models.length === 0 ? (
        <p className="border-t border-rule pt-2 text-xs text-muted">
          No models selected. Fetch them from the provider, or add an ID by hand.
        </p>
      ) : (
        <div className="border-t border-rule pt-2">
          {models.length > 8 ? (
            <div className="relative mb-2">
              <Search
                size={14}
                strokeWidth={1.75}
                aria-hidden="true"
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint"
              />
              <input
                value={query}
                type="search"
                placeholder="Filter models"
                aria-label="Filter models"
                onChange={(event) => setQuery(event.target.value)}
                className="min-h-8 w-full rounded-sm border border-rule-strong bg-surface py-1 pl-7 pr-2 text-sm transition-colors duration-150 ease-out-quart placeholder:text-faint hover:border-muted focus:border-accent"
              />
            </div>
          ) : null}

          {filtered.length === 0 ? (
            <p className="py-2 text-xs text-muted">No model matches this filter.</p>
          ) : (
            <ul className="max-h-72 overflow-y-auto">
              {filtered.map((model) => {
                const isDefault = model.id === defaultModel
                const expanded = expandedId === model.id
                return (
                  <li
                    key={model.id}
                    className="group flex flex-col border-b border-rule last:border-b-0"
                  >
                    <div className="flex items-center gap-2 py-0.5">
                      <label className="flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-2">
                        <input
                          type="radio"
                          name={`default-model-${provider.id}`}
                          checked={isDefault}
                          aria-label={`Use ${model.id} as the default model`}
                          onChange={() => onDefaultModelChange(model.id)}
                          className="size-3.5 shrink-0 accent-[var(--color-accent)]"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs text-ink">
                            {displayName(model)}
                          </span>
                          {model.name !== undefined ? (
                            <span className="block truncate font-mono text-[11px] text-faint">
                              {model.id}
                            </span>
                          ) : null}
                        </span>
                        {isDefault ? <span className="label-micro shrink-0">Default</span> : null}
                      </label>
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-label={`Edit capabilities for ${model.id}`}
                        title={`Capabilities for ${model.id}`}
                        onClick={() => setExpandedId(expanded ? null : model.id)}
                        className={`relative inline-flex size-7 shrink-0 items-center justify-center rounded-sm transition-colors duration-150 ease-out-quart after:absolute after:-inset-1 after:content-[''] hover:text-ink ${
                          model.caps !== undefined ? 'text-accent' : 'text-faint'
                        }`}
                      >
                        <Settings2 size={14} strokeWidth={1.75} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(model.id)}
                        aria-label={`Remove ${model.id}`}
                        title={`Remove ${model.id}`}
                        className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-faint transition-colors duration-150 ease-out-quart after:absolute after:-inset-1 after:content-[''] hover:text-danger"
                      >
                        <X size={14} strokeWidth={1.75} aria-hidden="true" />
                      </button>
                    </div>
                    {expanded ? (
                      <ModelCapsEditor
                        key={model.id}
                        model={model}
                        onChange={updateModel}
                      />
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}

          <p className="mt-2 flex items-center gap-1.5 text-xs text-faint">
            <TriangleAlert size={13} strokeWidth={1.75} aria-hidden="true" />
            Select the radio button to set which model requests use by default.
          </p>
        </div>
      )}
    </div>
  )
}
