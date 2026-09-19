import { useCallback, useEffect, useState } from 'react'
import { Check, MessageSquarePlus, PanelLeftClose, Pencil, Trash2, X } from 'lucide-react'
import { listThreadSummaries } from '../../chat/persistence'
import type { ThreadSummary } from '../../chat/persistence'
import { rehydrateThread } from '../../chat/sanitize'
import { useChatStore } from '../../chat/store'
import {
  createConversation,
  defaultProviderFor,
  deleteConversation,
  groupConversations,
  normalizeTitle,
  renameConversation,
} from '../../chat/threads'
import { defaultThreadConfig } from '../../chat/types'
import { useSession } from '../../session/session-context'
import { useVaultStore } from '../../vault/store'
import { Button, Input } from '../primitives'

function RowAction({
  label,
  onClick,
  children,
}: {
  label: string
  onClick(): void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-8 items-center justify-center rounded-sm text-muted transition-colors hover:text-ink"
    >
      {children}
    </button>
  )
}

export function Conversations({
  onOpenProviders,
  onClose,
  onCollapse,
}: {
  onOpenProviders(): void
  onClose?(): void
  onCollapse?(): void
}) {
  const session = useSession()
  const settings = useVaultStore((s) => s.settings)
  const activeThreadId = useChatStore((s) => s.activeThreadId)
  const runningThreads = useChatStore((s) => s.runningThreads)
  // Re-list when the in-memory thread set changes, so a conversation created
  // from the composer (first send) appears without reopening the panel.
  const knownThreadIds = useChatStore((s) => Object.keys(s.threads).sort().join(','))

  const [summaries, setSummaries] = useState<ThreadSummary[]>([])
  const [failures, setFailures] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const result = await listThreadSummaries()
    setSummaries(result.summaries)
    setFailures(result.failures)
    return result.summaries
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await listThreadSummaries()
      if (cancelled) return
      setSummaries(result.summaries)
      setFailures(result.failures)
    })()
    return () => {
      cancelled = true
    }
  }, [knownThreadIds])

  const provider = defaultProviderFor(settings)

  const openThread = useCallback(
    async (id: string) => {
      const loaded = await session.threadStore.loadThread(id)
      if (!loaded) return
      useChatStore.getState().setThread(rehydrateThread(loaded))
      useChatStore.getState().setActiveThread(id)
    },
    [session],
  )

  const create = useCallback(async () => {
    if (!provider) return
    const workspace = session.getWorkspace()
    const thread = await createConversation({
      config: defaultThreadConfig(provider.providerId, provider.modelId),
      workspaceName: workspace?.handle.name,
    })
    useChatStore.getState().setThread(thread)
    useChatStore.getState().setActiveThread(thread.id)
    await refresh()
  }, [provider, session, refresh])

  const commitRename = useCallback(async () => {
    if (!editingId) return
    const title = normalizeTitle(draft)
    const current = useChatStore.getState().threads[editingId]
    if (current) useChatStore.getState().setThread({ ...current, title })
    setEditingId(null)
    await renameConversation(editingId, title)
    await refresh()
  }, [editingId, draft, refresh])

  const remove = useCallback(
    async (id: string) => {
      setConfirmingId(null)
      await deleteConversation(id)
      useChatStore.getState().removeThread(id)
      session.disposeThread(id)
      await refresh()
    },
    [session, refresh],
  )

  const groups = groupConversations(summaries)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-rule px-3 py-2">
        <span className="label-micro">Conversations</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="New conversation"
            title={provider ? 'New conversation' : 'Configure a provider first'}
            disabled={!provider}
            onClick={() => void create()}
            className="relative inline-flex size-8 items-center justify-center rounded-sm text-muted transition-colors after:absolute after:-inset-1 after:content-[''] hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
          >
            <MessageSquarePlus size={16} strokeWidth={1.75} />
          </button>
          {onCollapse ? (
            <button
              type="button"
              aria-label="Hide conversations"
              title="Hide conversations"
              onClick={onCollapse}
              className="relative inline-flex size-8 items-center justify-center rounded-sm text-muted transition-colors after:absolute after:-inset-1 after:content-[''] hover:text-ink"
            >
              <PanelLeftClose size={16} strokeWidth={1.75} />
            </button>
          ) : null}
          {onClose ? (
            <button
              type="button"
              aria-label="Close conversations"
              onClick={onClose}
              className="relative inline-flex size-8 items-center justify-center rounded-sm text-muted transition-colors after:absolute after:-inset-1 after:content-[''] hover:text-ink"
            >
              <X size={16} strokeWidth={1.75} />
            </button>
          ) : null}
        </div>
      </div>

      {!provider ? (
        <div className="border-b border-rule px-3 py-2 text-xs text-faint">
          No provider configured.{' '}
          <Button variant="quiet" className="min-h-0 px-1 py-0 text-xs" onClick={onOpenProviders}>
            Open Providers
          </Button>
        </div>
      ) : null}

      {failures > 0 ? (
        <p role="status" className="border-b border-caution-rule bg-caution-soft px-3 py-1.5 text-xs text-caution">
          {failures} conversation{failures === 1 ? '' : 's'} could not be read.
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {groups.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-faint">No conversations yet.</p>
        ) : (
          groups.map((group) => (
            <section key={group.workspaceName ?? '__none__'} className="mb-3">
              <p className="label-micro px-2 py-1.5">{group.workspaceName ?? 'No workspace'}</p>
              <ul className="flex flex-col gap-0.5">
                {group.threads.map((summary) => {
                  const isActive = summary.id === activeThreadId
                  const isRunning = (runningThreads[summary.id] ?? 0) > 0
                  if (editingId === summary.id) {
                    return (
                      <li key={summary.id} className="flex items-center gap-1 px-1">
                        <Input
                          size="sm"
                          value={draft}
                          autoFocus
                          aria-label="Conversation title"
                          onChange={(event) => setDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void commitRename()
                            if (event.key === 'Escape') setEditingId(null)
                          }}
                          className="min-h-8"
                        />
                        <RowAction label="Save title" onClick={() => void commitRename()}>
                          <Check size={15} strokeWidth={1.75} />
                        </RowAction>
                        <RowAction label="Cancel rename" onClick={() => setEditingId(null)}>
                          <X size={15} strokeWidth={1.75} />
                        </RowAction>
                      </li>
                    )
                  }
                  return (
                    <li key={summary.id}>
                      <div
                        className={`group flex items-center gap-1 rounded-sm px-1 ${
                          isActive ? 'bg-accent-soft' : 'hover:bg-paper-sunk'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => void openThread(summary.id)}
                          aria-current={isActive ? 'true' : undefined}
                          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left text-sm text-ink"
                        >
                          <span className="min-w-0 flex-1 truncate">{summary.title}</span>
                          {isRunning ? (
                            <span
                              aria-label="Streaming"
                              className="size-1.5 shrink-0 rounded-full bg-accent motion-safe:animate-pulse"
                            />
                          ) : null}
                        </button>
                        {confirmingId === summary.id ? (
                          <>
                            <RowAction label="Confirm delete" onClick={() => void remove(summary.id)}>
                              <Check size={15} strokeWidth={1.75} />
                            </RowAction>
                            <RowAction label="Cancel delete" onClick={() => setConfirmingId(null)}>
                              <X size={15} strokeWidth={1.75} />
                            </RowAction>
                          </>
                        ) : (
                          <>
                            <RowAction label={`Rename ${summary.title}`} onClick={() => {
                              setEditingId(summary.id)
                              setDraft(summary.title)
                            }}>
                              <Pencil size={14} strokeWidth={1.75} />
                            </RowAction>
                            <RowAction label={`Delete ${summary.title}`} onClick={() => setConfirmingId(summary.id)}>
                              <Trash2 size={14} strokeWidth={1.75} />
                            </RowAction>
                          </>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  )
}
