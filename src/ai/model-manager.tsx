import { useMemo, useState } from 'react'
import {
  CircleCheck,
  CircleX,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react'
import type { ProviderConfig } from '../vault/settings'
import { MAX_MODELS_PER_PROVIDER } from '../vault/settings'
import { fetchModels, mergeModels } from './model-catalog'

type DiscoveryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; added: number; found: number; truncated: number }
  | { status: 'error'; message: string }

export function ModelManager({
  provider,
  models,
  defaultModel,
  onModelsChange,
  onDefaultModelChange,
}: {
  provider: ProviderConfig
  models: string[]
  defaultModel: string
  onModelsChange: (models: string[]) => void
  onDefaultModelChange: (model: string) => void
}) {
  const [discovery, setDiscovery] = useState<DiscoveryState>({ status: 'idle' })
  const [query, setQuery] = useState('')
  const [manual, setManual] = useState('')

  const atCap = models.length >= MAX_MODELS_PER_PROVIDER

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return models
    return models.filter((model) => model.toLowerCase().includes(needle))
  }, [models, query])

  const discover = async () => {
    setDiscovery({ status: 'loading' })
    try {
      const found = await fetchModels(provider)
      const merged = mergeModels(models, found)
      onModelsChange(merged.models)
      if (!defaultModel && merged.models.length > 0) {
        onDefaultModelChange(merged.models[0])
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
    if (models.includes(id)) {
      setManual('')
      return
    }
    if (atCap) return
    onModelsChange([...models, id].sort((a, b) => a.localeCompare(b)))
    if (!defaultModel) onDefaultModelChange(id)
    setManual('')
  }

  const remove = (id: string) => {
    const next = models.filter((model) => model !== id)
    onModelsChange(next)
    if (defaultModel === id) onDefaultModelChange(next[0] ?? '')
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
            <ul className="max-h-56 overflow-y-auto">
              {filtered.map((model) => {
                const isDefault = model === defaultModel
                return (
                  <li
                    key={model}
                    className="group flex items-center gap-2 border-b border-rule py-0.5 last:border-b-0"
                  >
                    <label className="flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-2">
                      <input
                        type="radio"
                        name={`default-model-${provider.id}`}
                        checked={isDefault}
                        aria-label={`Use ${model} as the default model`}
                        onChange={() => onDefaultModelChange(model)}
                        className="size-3.5 shrink-0 accent-[var(--color-accent)]"
                      />
                      <span className="min-w-0 truncate font-mono text-xs text-ink">{model}</span>
                      {isDefault ? <span className="label-micro shrink-0">Default</span> : null}
                    </label>
                    <button
                      type="button"
                      onClick={() => remove(model)}
                      aria-label={`Remove ${model}`}
                      title={`Remove ${model}`}
                      className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-faint transition-colors duration-150 ease-out-quart after:absolute after:-inset-1 after:content-[''] hover:text-danger"
                    >
                      <X size={14} strokeWidth={1.75} aria-hidden="true" />
                    </button>
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
