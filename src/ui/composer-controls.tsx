import { useState } from 'react'
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search, Sparkles } from 'lucide-react'
import { Popover as PopoverPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'
import { ensureActiveThread } from '../chat/active-thread'
import { useChatStore } from '../chat/store'
import { defaultProviderFor, patchThreadConfig, patchThreadMode } from '../chat/threads'
import { DEFAULT_CHAT_MODE } from '../chat/threads'
import type { ChatMode, SkillRef, ThreadConfig } from '../chat/types'
import { useSession } from '../session/session-context'
import type { ProviderConfig } from '../vault/settings'
import { useVaultStore } from '../vault/store'

const TRIGGER =
  'text-muted-foreground hover:text-foreground inline-flex h-7 max-w-40 items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors hover:bg-paper-sunk disabled:cursor-not-allowed disabled:opacity-45'

const ITEM =
  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-paper-sunk disabled:cursor-not-allowed disabled:opacity-45'

const CONTENT =
  'z-50 w-72 rounded-sm border border-rule-strong bg-surface shadow-[0_1px_2px_oklch(0.22_0.02_264/0.05),0_12px_28px_-8px_oklch(0.22_0.02_264/0.16)] outline-none'

function sameSkill(a: SkillRef, b: SkillRef): boolean {
  return a.id === b.id && a.source === b.source
}

function providerHost(baseURL: string): string {
  try {
    return new URL(baseURL).host
  } catch {
    return baseURL || 'not set'
  }
}

type Level = { kind: 'providers' } | { kind: 'models'; providerId: string }

function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange(value: string): void
  placeholder: string
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <Search
        size={13}
        strokeWidth={1.75}
        aria-hidden="true"
        className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-faint"
      />
      <input
        value={value}
        autoFocus
        spellCheck={false}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-7 w-full bg-transparent pl-6 pr-1 text-xs text-ink outline-none placeholder:text-faint"
      />
    </div>
  )
}

function ModelPickerBody({
  providers,
  providerId,
  modelId,
  saving,
  onSelect,
}: {
  providers: readonly ProviderConfig[]
  providerId: string | undefined
  modelId: string | undefined
  saving: boolean
  onSelect(providerId: string, modelId: string | undefined): void
}) {
  const [level, setLevel] = useState<Level>(() =>
    providers.length === 1 ? { kind: 'models', providerId: providers[0].id } : { kind: 'providers' },
  )
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()

  const activeProvider =
    level.kind === 'models' ? providers.find((provider) => provider.id === level.providerId) : undefined

  const goToModels = (nextProviderId: string) => {
    setLevel({ kind: 'models', providerId: nextProviderId })
    setQuery('')
  }

  return (
    <>
      <div className="flex items-center gap-1 border-b border-rule px-1.5 py-1">
        {level.kind === 'models' ? (
          <button
            type="button"
            aria-label="Back to providers"
            title="Back to providers"
            onClick={() => {
              setLevel({ kind: 'providers' })
              setQuery('')
            }}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted transition-colors hover:bg-paper-sunk hover:text-ink"
          >
            <ChevronLeft size={14} strokeWidth={1.75} />
          </button>
        ) : null}
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder={level.kind === 'providers' ? 'Search providers' : 'Search models'}
        />
      </div>

      <div className="flex max-h-64 flex-col overflow-y-auto p-1">
        {level.kind === 'providers' ? (
          providers
            .filter((provider) =>
              `${provider.label} ${providerHost(provider.baseURL)} ${provider.id}`
                .toLowerCase()
                .includes(needle),
            )
            .map((provider) => (
              <button
                key={provider.id}
                type="button"
                onClick={() => goToModels(provider.id)}
                className={ITEM}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ink">
                    {provider.label || 'Untitled provider'}
                  </span>
                  <span className="block truncate font-mono text-faint">
                    {providerHost(provider.baseURL)}
                  </span>
                </span>
                <span className="numeric shrink-0 font-mono text-faint">
                  {provider.models.length}
                </span>
                <ChevronRight size={13} strokeWidth={1.75} className="shrink-0 text-faint" />
              </button>
            ))
        ) : (
          <>
            {activeProvider ? (
              <p className="label-micro px-2 py-1">{activeProvider.label || 'Provider'}</p>
            ) : null}
            {(activeProvider ? [undefined, ...activeProvider.models] : [undefined])
              .filter((model) => (model ?? 'default model').toLowerCase().includes(needle))
              .map((model) => {
                const selected =
                  activeProvider !== undefined &&
                  activeProvider.id === providerId &&
                  (model ?? undefined) === modelId
                return (
                  <button
                    key={model ?? '__default'}
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      if (activeProvider) onSelect(activeProvider.id, model)
                    }}
                    className={ITEM}
                  >
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate font-mono',
                        selected ? 'text-accent' : 'text-ink',
                      )}
                    >
                      {model ?? 'Default model'}
                    </span>
                    {selected ? (
                      <Check size={13} strokeWidth={2} className="shrink-0 text-accent" />
                    ) : null}
                  </button>
                )
              })}
          </>
        )}
      </div>
    </>
  )
}

/**
 * Composer-level model and skills controls. Both write the active thread's
 * config, creating the conversation on first use so a picker is never dead
 * before the first message. Skills here can only toggle ones already enabled
 * globally; the registry filters out the rest, and the Skills panel owns that
 * trust decision.
 */
export function ComposerControls() {
  const session = useSession()
  const settings = useVaultStore((s) => s.settings)
  const providers = settings?.providers ?? []
  const config = useChatStore((s) =>
    s.activeThreadId ? s.threads[s.activeThreadId]?.config : undefined,
  )
  const mode =
    useChatStore((s) => (s.activeThreadId ? s.threads[s.activeThreadId]?.mode : undefined)) ??
    DEFAULT_CHAT_MODE
  const [modelOpen, setModelOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const fallback = defaultProviderFor(settings)
  const providerId = config?.providerId ?? fallback?.providerId
  const modelId = config?.modelId ?? fallback?.modelId
  const selectedProvider = providers.find((provider) => provider.id === providerId)
  const modelLabel = modelId ?? selectedProvider?.defaultModel ?? selectedProvider?.label ?? 'No model'

  const availableSkills = session.skillRegistry
    .list()
    .filter((skill) => session.skillRegistry.isEnabled({ id: skill.id, source: skill.source }))
  const enabledSkills = config?.enabledSkills ?? []

  const applyConfig = async (patch: Partial<ThreadConfig>) => {
    setSaving(true)
    try {
      const id = await ensureActiveThread(session)
      if (!id) return
      const thread = useChatStore.getState().threads[id]
      if (!thread) return
      const next = patchThreadConfig(thread, patch)
      useChatStore.getState().setThread(next)
      await session.threadStore.saveThread(next)
      useChatStore.getState().setError(null)
    } catch (cause) {
      useChatStore
        .getState()
        .setError(cause instanceof Error ? cause.message : 'The change could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  const applyMode = async (next: ChatMode) => {
    setSaving(true)
    try {
      const id = await ensureActiveThread(session)
      if (!id) return
      const thread = useChatStore.getState().threads[id]
      if (!thread) return
      const updated = patchThreadMode(thread, next)
      useChatStore.getState().setThread(updated)
      await session.threadStore.saveThread(updated)
      useChatStore.getState().setError(null)
    } catch (cause) {
      useChatStore
        .getState()
        .setError(cause instanceof Error ? cause.message : 'The change could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-center gap-1" data-composer-controls>
      <label className={TRIGGER} title="Permission mode for this conversation">
        <span className="sr-only">Permission mode</span>
        <select
          aria-label="Permission mode"
          className="min-w-0 bg-transparent font-mono outline-none"
          value={mode}
          disabled={saving}
          onChange={(event) => void applyMode(event.target.value as ChatMode)}
        >
          <option value="read_only">read only</option>
          <option value="editing">editing</option>
          <option value="god">god</option>
        </select>
      </label>
      <PopoverPrimitive.Root open={modelOpen} onOpenChange={setModelOpen}>
        <PopoverPrimitive.Trigger
          type="button"
          className={TRIGGER}
          disabled={providers.length === 0}
          title={providers.length === 0 ? 'Configure a provider in Config' : 'Change model'}
          aria-label="Change model"
        >
          <span className="min-w-0 truncate font-mono">{modelLabel}</span>
          <ChevronDown size={12} strokeWidth={1.75} className="shrink-0" />
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content side="top" align="start" sideOffset={8} className={CONTENT}>
            <ModelPickerBody
              providers={providers}
              providerId={providerId}
              modelId={modelId}
              saving={saving}
              onSelect={(nextProviderId, nextModelId) => {
                void applyConfig({ providerId: nextProviderId, modelId: nextModelId })
                setModelOpen(false)
              }}
            />
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>

      <PopoverPrimitive.Root>
        <PopoverPrimitive.Trigger
          type="button"
          className={TRIGGER}
          title="Skills for this conversation"
          aria-label="Skills for this conversation"
        >
          <Sparkles size={13} strokeWidth={1.75} className="shrink-0" />
          {enabledSkills.length > 0 ? (
            <span className="numeric font-mono">{enabledSkills.length}</span>
          ) : null}
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content side="top" align="start" sideOffset={8} className={CONTENT}>
            {availableSkills.length === 0 ? (
              <p className="px-2 py-2 text-xs leading-relaxed text-muted">
                No skills are enabled. Turn them on in the Skills panel first.
              </p>
            ) : (
              <div className="flex max-h-64 flex-col overflow-y-auto p-1">
                {availableSkills.map((skill) => {
                  const ref: SkillRef = { id: skill.id, source: skill.source }
                  const checked = enabledSkills.some((entry) => sameSkill(entry, ref))
                  return (
                    <label
                      key={`${skill.source}:${skill.id}`}
                      className={cn(ITEM, 'cursor-pointer')}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={saving}
                        onChange={(event) => {
                          const next = event.target.checked
                            ? [...enabledSkills, ref]
                            : enabledSkills.filter((entry) => !sameSkill(entry, ref))
                          void applyConfig({ enabledSkills: next })
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate text-ink">{skill.name}</span>
                      <span className="label-micro shrink-0">{skill.source}</span>
                    </label>
                  )
                })}
              </div>
            )}
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    </div>
  )
}
