import { describe, expect, it } from 'vitest'
import {
  FormInputError,
  InputJsonError,
  draftInput,
  editableInput,
  imageFields,
  initialValues,
  parseInputJson,
  storableInput,
  toProviderInput,
  valuesFromInput,
} from './form'
import type { FormField } from './types'

const base = { required: false, nullable: false, secret: false }

const fields: FormField[] = [
  { ...base, name: 'prompt', label: 'Prompt', kind: 'text', multiline: true, required: true },
  { ...base, name: 'steps', label: 'Steps', kind: 'integer', min: 1, max: 4, step: 1, default: 2 },
  { ...base, name: 'guidance', label: 'Guidance', kind: 'number', min: 0, max: 10, step: 0.01 },
  { ...base, name: 'ratio', label: 'Ratio', kind: 'select', options: ['1:1', 2] },
  { ...base, name: 'fast', label: 'Fast', kind: 'boolean', default: true },
  { ...base, name: 'extra', label: 'Extra', kind: 'json' },
  { ...base, name: 'image', label: 'Image', kind: 'image' },
  { ...base, name: 'images', label: 'Images', kind: 'images', default: [] },
  { ...base, name: 'key', label: 'Key', kind: 'text', multiline: false, secret: true, default: 'leaked' },
]

describe('form model', () => {
  it('starts from schema defaults but never pre-fills a secret', () => {
    const values = initialValues(fields)
    expect(values.steps).toBe(2)
    expect(values.fast).toBe(true)
    expect(values.key).toBeUndefined()
  })

  it('omits empty optional values so the provider applies its own defaults', () => {
    const input = toProviderInput(fields, { prompt: 'a cat', guidance: '', extra: '  ', image: '', images: [] })
    expect(input).toEqual({ prompt: 'a cat' })
  })

  it('coerces and clamps numbers to the schema bounds, since the provider rejects out-of-range values', () => {
    const input = toProviderInput(fields, { prompt: 'x', steps: '9.6', guidance: '-3', ratio: '2' })
    expect(input).toMatchObject({ steps: 4, guidance: 0, ratio: 2 })
  })

  it('parses JSON fields and names the field when the JSON is invalid', () => {
    expect(toProviderInput(fields, { prompt: 'x', extra: '{"a":1}' }).extra).toEqual({ a: 1 })
    const run = () => toProviderInput(fields, { prompt: 'x', extra: '{bad' })
    expect(run).toThrow(FormInputError)
    expect(run).toThrow(/Extra/)
  })

  it('reports a missing required field, including a required secret left empty', () => {
    expect(() => toProviderInput(fields, { prompt: '   ' })).toThrow(expect.objectContaining({ field: 'prompt' }))
    const secretRequired: FormField[] = [{ ...base, name: 'token', label: 'Token', kind: 'text', multiline: false, secret: true, required: true }]
    expect(() => toProviderInput(secretRequired, {})).toThrow(expect.objectContaining({ field: 'token' }))
  })

  it('keeps image URIs for single and multi-image inputs and lists those fields', () => {
    const input = toProviderInput(fields, { prompt: 'x', image: 'data:image/png;base64,AA', images: ['https://a', ''] })
    expect(input).toMatchObject({ image: 'data:image/png;base64,AA', images: ['https://a'] })
    expect(imageFields(fields).map((field) => field.name)).toEqual(['image', 'images'])
  })
})

describe('JSON input mode', () => {
  it('turns form values into a JSON draft without throwing on a field that is still incomplete', () => {
    const draft = draftInput(fields, { steps: '9', extra: '{bad', ratio: 2, key: 'typed-secret', image: 'data:x' })
    expect(draft).toEqual({ steps: 4, ratio: 2, key: 'typed-secret' })
  })

  it('fills the form back from JSON and names the keys the form has no control for', () => {
    const { values, dropped } = valuesFromInput(fields, {
      prompt: 'a cat',
      steps: 3,
      fast: false,
      extra: { a: 1 },
      image: 'https://example.com/a.png',
      images: [{ $image: 0 }],
      webhook_mode: 'x',
    })
    expect(values).toMatchObject({ prompt: 'a cat', steps: 3, fast: false, extra: '{\n  "a": 1\n}', guidance: undefined })
    expect(dropped).toEqual(['image', 'webhook_mode'])
  })

  it('shows a stored run as editable JSON without the internal image references', () => {
    expect(editableInput(fields, { prompt: 'x', image: { $image: 0 }, images: [{ $image: 1 }], other: 1 })).toEqual({
      prompt: 'x',
      other: 1,
    })
  })

  it('accepts only a JSON object, since the provider input is a keyed object', () => {
    expect(parseInputJson('{"prompt":"a"}')).toEqual({ prompt: 'a' })
    expect(() => parseInputJson('{"prompt":')).toThrow(InputJsonError)
    expect(() => parseInputJson('[1]')).toThrow('must be an object')
    expect(() => parseInputJson('null')).toThrow('must be an object')
  })

  it('never stores an undeclared key whose name looks like a credential, since raw JSON can add any key', () => {
    const stored = storableInput(fields, { prompt: 'x', hf_token: 'secret', seed_value: 3 })
    expect(stored.input).toEqual({ prompt: 'x', seed_value: 3 })
    expect(stored.secretFields).toEqual(['hf_token'])
  })

  it('keeps a __proto__ key as data instead of changing the object prototype', () => {
    const parsed = parseInputJson('{"__proto__":{"polluted":true},"prompt":"x"}')
    const editable = editableInput(fields, parsed)
    expect(Object.getPrototypeOf(editable)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})
