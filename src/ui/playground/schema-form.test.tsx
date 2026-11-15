// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FormField } from '../../playground/types'
import { SchemaForm } from './schema-form'
import type { PendingImage } from './schema-form'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const base = { required: false, nullable: false, secret: false }

const fields: FormField[] = [
  { ...base, name: 'prompt', label: 'Prompt', kind: 'text', multiline: true, required: true, description: 'Say <img src=x onerror=alert(1)> hi' },
  { ...base, name: 'ratio', label: 'Ratio', kind: 'select', options: ['1:1', '16:9'], default: '1:1' },
  { ...base, name: 'steps', label: 'Steps', kind: 'integer', min: 1, max: 4, step: 1 },
  { ...base, name: 'seed', label: 'Seed', kind: 'integer', step: 1 },
  { ...base, name: 'fast', label: 'Fast', kind: 'boolean' },
  { ...base, name: 'extra', label: 'Extra', kind: 'json' },
  { ...base, name: 'input_image', label: 'Input image', kind: 'image' },
  { ...base, name: 'api_key', label: 'API key', kind: 'text', multiline: false, secret: true },
]

async function render(overrides: Partial<Parameters<typeof SchemaForm>[0]> = {}) {
  const onValueChange = vi.fn()
  const onImagesChange = vi.fn()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <SchemaForm
        fields={fields}
        values={{ ratio: '1:1' }}
        images={{}}
        owner="someone"
        error={null}
        onValueChange={onValueChange}
        onImagesChange={onImagesChange}
        {...overrides}
      />,
    )
  })
  return { container, onValueChange, onImagesChange }
}

function control(container: HTMLElement, label: string): HTMLElement {
  const element = container.querySelector(`[aria-label="${label}"]`)
  if (!(element instanceof HTMLElement)) throw new Error(`missing control ${label}`)
  return element
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
}

describe('SchemaForm', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders each field kind and reports edits by field name', async () => {
    const { container, onValueChange } = await render()
    await setValue(control(container, 'Prompt'), 'a cat')
    await setValue(control(container, 'Ratio'), '16:9')
    await setValue(control(container, 'Steps'), '3')
    await setValue(control(container, 'Seed'), '42')
    await setValue(control(container, 'Extra'), '{"a":1}')
    await act(async () => {
      control(container, 'Fast').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onValueChange.mock.calls).toEqual([
      ['prompt', 'a cat'],
      ['ratio', '16:9'],
      ['steps', '3'],
      ['seed', '42'],
      ['extra', '{"a":1}'],
      ['fast', true],
    ])
    expect(container.querySelector('[aria-label="Steps slider"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Seed slider"]')).toBeNull()
  })

  it('renders model-authored descriptions as text, never as markup', async () => {
    const { container } = await render()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('shows secrets as password inputs with a warning naming the model author', async () => {
    const { container } = await render()
    expect(control(container, 'API key').getAttribute('type')).toBe('password')
    expect(container.textContent).toContain('This value goes to the model author someone. It is never saved.')
  })

  it('accepts an image file and rejects one over 25 MB', async () => {
    const { container, onImagesChange } = await render()
    const input = control(container, 'Input image') as HTMLInputElement
    const small = new File(['png'], 'cat.png', { type: 'image/png' })
    const huge = new File(['x'], 'huge.png', { type: 'image/png' })
    Object.defineProperty(huge, 'size', { value: 25 * 1024 * 1024 + 1 })
    for (const file of [small, huge]) {
      Object.defineProperty(input, 'files', { value: [file], configurable: true })
      await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })
    }
    expect(onImagesChange).toHaveBeenCalledTimes(1)
    const [name, images] = onImagesChange.mock.calls[0] as [string, PendingImage[]]
    expect(name).toBe('input_image')
    expect(images[0].name).toBe('cat.png')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('huge.png is larger than 25 MB.')
  })

  it('shows the error under the field it belongs to', async () => {
    const { container } = await render({ error: { field: 'prompt', message: 'Prompt is required.' } })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Prompt is required.')
  })

  it('keeps prompts, images, and required fields on top and groups the optional parameters', async () => {
    const { container } = await render()
    const details = container.querySelector('details')
    expect(details?.hasAttribute('open')).toBe(true)
    expect(details?.querySelector('summary')?.textContent).toBe('Parameters6')
    expect(details?.querySelector('[aria-label="Prompt"]')).toBeNull()
    expect(details?.querySelector('[aria-label="Input image"]')).toBeNull()
    expect(details?.querySelector('[aria-label="Ratio"]')).not.toBeNull()
  })
})
