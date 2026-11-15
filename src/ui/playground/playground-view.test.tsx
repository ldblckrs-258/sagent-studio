// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlaygroundProvider } from '../../playground/provider'
import { usePlaygroundStore } from '../../playground/state'
import type { FormField, PlaygroundModel, ProviderRun } from '../../playground/types'
import { useWorkspaceStore } from '../../session/workspace-state'
import { defaultSettings } from '../../vault/settings'
import { useVaultStore } from '../../vault/store'
import { createFakeWorkspace } from '../../workspace/fake-handle'
import { createWorkspaceFs, readWorkspaceBlob } from '../../workspace/fs'
import PlaygroundView from './playground-view'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const harness = vi.hoisted(() => ({
  provider: null as PlaygroundProvider | null,
  workspace: null as { handle: FileSystemDirectoryHandle } | null,
  runs: new Map<string, import('../../playground/store').RunMeta>(),
  images: new Map<string, Blob>(),
}))

vi.mock('../../playground/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../playground/registry')>()
  return { ...actual, providerFor: () => harness.provider }
})

vi.mock('../../playground/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../playground/state')>()
  const { runs, images } = harness
  const keep = (runId: string, role: string, blobs: readonly Blob[]) =>
    blobs.forEach((blob, index) => images.set(`${runId}:${role}:${index}`, blob))
  const memory: import('../../playground/store').PlaygroundPersistence = {
    list: async () => ({ runs: [...runs.values()].sort((a, b) => b.createdAt - a.createdAt), skipped: 0 }),
    create: async (meta, inputImages) => {
      runs.set(meta.id, meta)
      keep(meta.id, 'input', inputImages)
      return []
    },
    update: async (meta) => {
      if (!runs.has(meta.id)) return false
      runs.set(meta.id, meta)
      return true
    },
    addOutputs: async (meta, outputs) => {
      if (!runs.has(meta.id)) return null
      runs.set(meta.id, meta)
      keep(meta.id, 'output', outputs)
      return []
    },
    loadImage: async (id) => {
      const blob = images.get(id)
      if (!blob) throw new Error('missing image')
      return new Uint8Array(await blob.arrayBuffer())
    },
    remove: async (ids) => {
      for (const id of ids) runs.delete(id)
    },
  }
  return { ...actual, usePlaygroundStore: actual.createPlaygroundStore(memory, { pollMs: 1 }) }
})

vi.mock('../monaco-editor', () => ({
  MonacoEditor: ({ value, onChange, ariaLabel }: { value: string; onChange(value: string): void; ariaLabel?: string }) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}))

vi.mock('../../playground/folder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../playground/folder')>()
  const { createWorkspaceFs: create } = await import('../../workspace/fs')
  return {
    ...actual,
    restorePlaygroundFolder: async () => null,
    choosePlaygroundFolder: async () => create(harness.workspace!.handle),
  }
})

const fields: FormField[] = [
  { name: 'prompt', label: 'Prompt', kind: 'text', multiline: true, required: true, nullable: false, secret: false },
  { name: 'api_key', label: 'API key', kind: 'text', multiline: false, required: false, nullable: false, secret: true },
]

const model: PlaygroundModel = {
  providerId: 'replicate',
  slug: 'black-forest-labs/flux-schnell',
  label: 'black-forest-labs/flux-schnell',
  description: 'Fast model',
  fields,
  editsImages: false,
  ref: { isOfficial: true, versionId: 'v1' },
}

function fakeProvider(final: ProviderRun['status'] = 'succeeded') {
  return {
    id: 'replicate' as const,
    retentionMs: 55 * 60_000,
    verify: vi.fn(async () => ({ account: 'me' })),
    getModel: vi.fn(async () => model),
    prepareImage: vi.fn(async () => 'data:image/png;base64,AA'),
    start: vi.fn(async (): Promise<ProviderRun> => ({ providerRunId: 'pred-1', status: 'starting' })),
    poll: vi.fn(async (): Promise<ProviderRun> =>
      final === 'succeeded'
        ? { providerRunId: 'pred-1', status: 'succeeded', outputs: [{ url: 'https://replicate.delivery/a/out.png' }] }
        : { providerRunId: 'pred-1', status: final },
    ),
    cancel: vi.fn(async () => undefined),
    download: vi.fn(async () => ({ blob: new Blob(['png-bytes'], { type: 'image/png' }), mime: 'image/png' })),
  } satisfies PlaygroundProvider
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return
    await settle()
  }
  const runs = usePlaygroundStore.getState().runs.map((run) => `${run.status}:${run.error ?? ''}`)
  throw new Error(`Timed out waiting for the view. Runs: ${runs.join(', ')}`)
}

async function mount(onOpenProviders = vi.fn()) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<PlaygroundView onOpenProviders={onOpenProviders} />)
  })
  await settle()
  return { container, onOpenProviders, unmount: () => act(() => root.unmount()) }
}

function byLabel(container: HTMLElement, label: string): HTMLElement {
  const element = container.querySelector(`[aria-label="${label}"]`)
  if (!(element instanceof HTMLElement)) throw new Error(`missing ${label}`)
  return element
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((entry) => entry.textContent?.trim() === text)
  if (!button) throw new Error(`missing button ${text}`)
  return button
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}

async function setValue(element: HTMLElement, value: string): Promise<void> {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
  await settle()
}

async function submit(container: HTMLElement): Promise<void> {
  await act(async () => {
    buttonByText(container, 'Run').closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await settle()
}

async function loadModelAndRun(container: HTMLElement, values: Record<string, string>): Promise<void> {
  await setValue(byLabel(container, 'Quick pick'), 'black-forest-labs/flux-schnell')
  await until(() => container.querySelector('[aria-label="Prompt"]') !== null)
  for (const [label, value] of Object.entries(values)) await setValue(byLabel(container, label), value)
  await submit(container)
}

describe('PlaygroundView', () => {
  let urlCount = 0

  beforeEach(async () => {
    harness.runs.clear()
    harness.images.clear()
    usePlaygroundStore.getState().clear()
    useVaultStore.setState({
      status: 'unlocked',
      settings: { ...defaultSettings(), playgroundProviders: { replicate: { apiKey: 'r8_test' } } },
    })
    harness.provider = fakeProvider()
    harness.workspace = createFakeWorkspace()
    URL.createObjectURL = vi.fn(() => `blob:test-${++urlCount}`)
    URL.revokeObjectURL = vi.fn()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('asks for a provider token before anything else', async () => {
    useVaultStore.setState({ settings: defaultSettings() })
    const { container, onOpenProviders } = await mount()
    expect(container.textContent).toContain('Add a provider token to use the Playground.')
    await click(buttonByText(container, 'Open Config → Providers'))
    expect(onOpenProviders).toHaveBeenCalled()
  })

  it('runs a model from the generated form and shows the stored output', async () => {
    const { container } = await mount()
    await loadModelAndRun(container, { Prompt: 'a cat' })
    expect(harness.provider?.start).toHaveBeenCalledWith(model, { prompt: 'a cat' }, expect.anything())
    await until(() => container.textContent?.includes('succeeded') === true)
    await until(() => container.querySelector('img[alt="black-forest-labs/flux-schnell output 1"]') !== null)
    expect(container.querySelector('img[alt="black-forest-labs/flux-schnell output 1"]')?.getAttribute('src')).toMatch(/^blob:/)
  })

  it('shows the required-field error instead of starting a run', async () => {
    const { container } = await mount()
    await loadModelAndRun(container, {})
    expect(harness.provider?.start).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Prompt is required.')
  })

  it('cancels a running prediction on the provider', async () => {
    harness.provider = fakeProvider('processing')
    const { container } = await mount()
    await loadModelAndRun(container, { Prompt: 'slow' })
    await until(() => usePlaygroundStore.getState().runs[0]?.providerRunId === 'pred-1')
    await click(buttonByText(container, 'Cancel'))
    expect(harness.provider.cancel).toHaveBeenCalledWith('pred-1')
    expect(container.textContent).toContain('canceling')
  })

  it('refills the form from a run but leaves secrets empty, and Re-run waits for them', async () => {
    const { container } = await mount()
    await loadModelAndRun(container, { Prompt: 'with key', 'API key': 'sk-never-stored' })
    await until(() => container.textContent?.includes('succeeded') === true)
    expect(harness.provider?.start).toHaveBeenCalledTimes(1)

    await setValue(byLabel(container, 'Prompt'), 'edited')
    await click(byLabel(container, 'Use settings'))
    await until(() => (byLabel(container, 'Prompt') as HTMLTextAreaElement).value === 'with key')
    expect((byLabel(container, 'API key') as HTMLInputElement).value).toBe('')
    expect(container.textContent).toContain('Enter this secret again')

    await click(byLabel(container, 'Re-run'))
    await settle()
    expect(harness.provider?.start).toHaveBeenCalledTimes(1)
  })

  it('re-runs immediately when the run used no secrets', async () => {
    const { container } = await mount()
    await loadModelAndRun(container, { Prompt: 'again' })
    await until(() => container.textContent?.includes('succeeded') === true)
    await click(byLabel(container, 'Re-run'))
    await until(() => vi.mocked(harness.provider!.start).mock.calls.length === 2)
    expect(harness.provider?.start).toHaveBeenLastCalledWith(model, { prompt: 'again' }, expect.anything())
  })

  it('downloads the original bytes with an extension from the media type', async () => {
    const clicked: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this)
    })
    const { container } = await mount()
    await loadModelAndRun(container, { Prompt: 'download me' })
    await until(() => container.querySelector('[aria-label="Download"]') !== null)
    await click(byLabel(container, 'Download'))
    await until(() => clicked.length === 1)
    expect(clicked[0].download).toMatch(/^flux-schnell-[0-9a-f]{8}-0\.png$/)
  })

  it('saves into the Playground folder without touching the conversation workspace', async () => {
    const pick = vi.spyOn(useWorkspaceStore.getState(), 'pick')
    const { container } = await mount()
    await loadModelAndRun(container, { Prompt: 'save me' })
    await until(() => container.querySelector('[aria-label="Save to folder"]') !== null)
    await click(byLabel(container, 'Save to folder'))
    await until(() => container.textContent?.includes('Saved ') === true)
    expect(pick).not.toHaveBeenCalled()
    const fs = createWorkspaceFs(harness.workspace!.handle)
    const saved = (await fs.list('')).find((entry) => entry.name.endsWith('.png'))
    expect(saved).toBeDefined()
    expect(await (await readWorkspaceBlob(fs, saved!.path)).text()).toBe('png-bytes')
  })

  it('offers Retry download for a run whose image could not be fetched, and stores the image on retry', async () => {
    harness.provider!.download = vi
      .fn()
      .mockRejectedValueOnce(new Error('The file host could not be reached (HTTP 502).'))
      .mockResolvedValue({ blob: new Blob(['png-bytes'], { type: 'image/png' }), mime: 'image/png' })
    const { container } = await mount()
    await loadModelAndRun(container, { Prompt: 'flaky' })
    await until(() => container.textContent?.includes('Retry download') === true)
    expect(container.querySelector('[aria-label="Download"]')).toBeNull()
    await click(buttonByText(container, 'Retry download'))
    await until(() => container.querySelector('[aria-label="Download"]') !== null)
    expect(container.textContent).not.toContain('Retry download')
    expect(container.textContent).not.toContain('could not be reached')
  })

  it('collapses the picker into a model header once a model loads, and Change reopens it', async () => {
    const { container } = await mount()
    await setValue(byLabel(container, 'Quick pick'), 'black-forest-labs/flux-schnell')
    await until(() => container.querySelector('[aria-label="Prompt"]') !== null)
    expect(container.querySelector('[aria-label="Quick pick"]')).toBeNull()
    expect(container.querySelector('h2')?.textContent).toBe('black-forest-labs/flux-schnell')
    await click(buttonByText(container, 'Change'))
    expect(container.querySelector('[aria-label="Quick pick"]')).not.toBeNull()
  })

  it('runs the raw JSON input, including keys the form does not declare, and never stores a credential-named key', async () => {
    const { container } = await mount()
    await setValue(byLabel(container, 'Quick pick'), 'black-forest-labs/flux-schnell')
    await until(() => container.querySelector('[aria-label="Prompt"]') !== null)
    await setValue(byLabel(container, 'Prompt'), 'from form')
    await click(buttonByText(container, 'JSON'))
    const editor = byLabel(container, 'JSON input') as HTMLTextAreaElement
    expect(JSON.parse(editor.value)).toEqual({ prompt: 'from form' })
    await setValue(editor, '{"prompt":"from json","num_outputs":2,"hf_token":"tok-secret"}')
    await submit(container)
    expect(harness.provider?.start).toHaveBeenCalledWith(
      model,
      { prompt: 'from json', num_outputs: 2, hf_token: 'tok-secret' },
      expect.anything(),
    )
    await until(() => usePlaygroundStore.getState().runs.length === 1)
    const stored = usePlaygroundStore.getState().runs[0]
    expect(stored.input).toEqual({ prompt: 'from json', num_outputs: 2 })
    expect(stored.secretFields).toEqual(['hf_token'])
  })

  it('blocks a run when the JSON is not an object', async () => {
    const { container } = await mount()
    await setValue(byLabel(container, 'Quick pick'), 'black-forest-labs/flux-schnell')
    await until(() => container.querySelector('[aria-label="Prompt"]') !== null)
    await click(buttonByText(container, 'JSON'))
    await setValue(byLabel(container, 'JSON input'), '["a cat"]')
    await submit(container)
    expect(harness.provider?.start).not.toHaveBeenCalled()
    expect(container.textContent).toContain('must be an object')
  })

  it('fills the form back from JSON and says which keys the form cannot show', async () => {
    const { container } = await mount()
    await setValue(byLabel(container, 'Quick pick'), 'black-forest-labs/flux-schnell')
    await until(() => container.querySelector('[aria-label="Prompt"]') !== null)
    await click(buttonByText(container, 'JSON'))
    await setValue(byLabel(container, 'JSON input'), '{"prompt":"back to form","num_outputs":2}')
    await click(buttonByText(container, 'Form'))
    expect((byLabel(container, 'Prompt') as HTMLTextAreaElement).value).toBe('back to form')
    expect(container.textContent).toContain('The form has no control for num_outputs')

    await click(buttonByText(container, 'JSON'))
    await setValue(byLabel(container, 'JSON input'), '{"prompt":')
    await click(buttonByText(container, 'Form'))
    expect(container.querySelector('[aria-label="JSON input"]')).not.toBeNull()
    expect(container.textContent).toContain('Fix it before switching to Form.')
  })

  it('refills the JSON editor from a run when JSON mode is on', async () => {
    const { container } = await mount()
    await loadModelAndRun(container, { Prompt: 'remember me' })
    await until(() => container.textContent?.includes('succeeded') === true)
    await click(buttonByText(container, 'JSON'))
    await setValue(byLabel(container, 'JSON input'), '{"prompt":"changed"}')
    await click(byLabel(container, 'Use settings'))
    await until(() => (byLabel(container, 'JSON input') as HTMLTextAreaElement).value.includes('remember me'))
  })

  it('runs with Ctrl+Enter from inside the form', async () => {
    const { container } = await mount()
    await setValue(byLabel(container, 'Quick pick'), 'black-forest-labs/flux-schnell')
    await until(() => container.querySelector('[aria-label="Prompt"]') !== null)
    await setValue(byLabel(container, 'Prompt'), 'shortcut')
    await act(async () => {
      byLabel(container, 'Prompt').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    })
    await until(() => vi.mocked(harness.provider!.start).mock.calls.length === 1)
    expect(harness.provider?.start).toHaveBeenCalledWith(model, { prompt: 'shortcut' }, expect.anything())
  })

  it('groups runs with the same settings under one card and still lists each run', async () => {
    const { container } = await mount()
    await loadModelAndRun(container, { Prompt: 'same settings' })
    await until(() => container.textContent?.includes('succeeded') === true)
    await click(byLabel(container, 'Re-run'))
    await until(() => usePlaygroundStore.getState().runs.filter((run) => run.status === 'succeeded').length === 2)
    await until(() => container.querySelectorAll('img[alt$="output 1"]').length === 2)
    const cards = container.querySelectorAll('article')
    expect(cards).toHaveLength(1)
    expect(cards[0].getAttribute('data-run-count')).toBe('2')
    expect(cards[0].textContent).toContain('×2')
    expect(cards[0].querySelectorAll('section[data-run-id]')).toHaveLength(2)
    expect(container.querySelector('[aria-label="Delete 2 runs"]')).not.toBeNull()

    await setValue(byLabel(container, 'Prompt'), 'different settings')
    await submit(container)
    await until(() => container.querySelectorAll('article').length === 2)
  })

  it('collapses a run card to its header, and collapses or expands every card at once', async () => {
    const { container } = await mount()
    await loadModelAndRun(container, { Prompt: 'fold me' })
    await until(() => container.querySelector('[aria-label="Download"]') !== null)
    const toggle = container.querySelector('article button[aria-expanded]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    await click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[aria-label="Download"]')).toBeNull()
    expect(container.querySelector('article')?.textContent).toContain('1 image')
    await click(byLabel(container, 'Expand all'))
    expect(container.querySelector('[aria-label="Download"]')).not.toBeNull()
    await click(byLabel(container, 'Collapse all'))
    expect(container.querySelector('[aria-label="Download"]')).toBeNull()
  })

  it('shows every output as one image wall in gallery view and counts runs that have no image', async () => {
    const { container } = await mount()
    await loadModelAndRun(container, { Prompt: 'wall' })
    await until(() => container.querySelector('[aria-label="Download"]') !== null)
    vi.mocked(harness.provider!.poll).mockResolvedValue({ providerRunId: 'pred-1', status: 'failed' })
    await setValue(byLabel(container, 'Prompt'), 'broken')
    await submit(container)
    await until(() => usePlaygroundStore.getState().runs.some((run) => run.status === 'failed'))
    await click(buttonByText(container, 'Gallery'))
    expect(container.querySelector('article')).toBeNull()
    expect(container.querySelectorAll('figure')).toHaveLength(1)
    expect(container.querySelector('figure')?.getAttribute('title')).toBe('wall')
    expect(container.textContent).toContain('1 run has no image.')
    await click(byLabel(container, 'Use settings'))
    await until(() => (byLabel(container, 'Prompt') as HTMLTextAreaElement).value === 'wall')
    await click(buttonByText(container, 'List'))
    expect(container.querySelectorAll('article')).toHaveLength(2)
  })
})
