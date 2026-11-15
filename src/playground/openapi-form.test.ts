import { describe, expect, it } from 'vitest'
import { MAX_FORM_FIELDS, fieldsFromOpenApi } from './openapi-form'
import { storableInput, toProviderInput } from './form'

const enumeration = (values: string[]) => ({ enum: values, type: 'string', title: 'x', description: 'An enumeration.' })

const fluxSchnell = {
  input: {
    type: 'object',
    required: ['prompt'],
    properties: {
      seed: { type: 'integer', title: 'Seed', 'x-order': 4 },
      prompt: { type: 'string', title: 'Prompt', 'x-order': 0, description: 'Prompt for generated image' },
      go_fast: { type: 'boolean', title: 'Go Fast', default: true, 'x-order': 8 },
      num_outputs: { type: 'integer', title: 'Num Outputs', default: 1, maximum: 4, minimum: 1, 'x-order': 2 },
      aspect_ratio: {
        allOf: [{ $ref: '#/components/schemas/aspect_ratio' }],
        default: '1:1',
        'x-order': 1,
        description: 'Aspect ratio for the generated image',
      },
    },
  },
  components: { aspect_ratio: enumeration(['1:1', '16:9', '9:16']) },
}

const fluxKontextPro = {
  input: {
    type: 'object',
    required: ['prompt'],
    properties: {
      seed: { type: 'integer', title: 'Seed', nullable: true },
      prompt: { type: 'string', title: 'Prompt' },
      input_image: { type: 'string', title: 'Input Image', format: 'uri', nullable: true },
      aspect_ratio: { allOf: [{ $ref: '#/components/schemas/aspect_ratio' }], default: 'match_input_image', 'x-order': 2 },
      safety_tolerance: { type: 'integer', title: 'Safety Tolerance', default: 2, maximum: 6, minimum: 0 },
    },
  },
  components: { aspect_ratio: enumeration(['match_input_image', '1:1']) },
}

const nanoBanana = {
  type: 'object',
  required: ['prompt'],
  properties: {
    prompt: { type: 'string', title: 'Prompt', 'x-order': 0 },
    image_input: { type: 'array', items: { type: 'string', format: 'uri', anyOf: [] }, default: [], 'x-order': 1 },
  },
}

describe('fieldsFromOpenApi', () => {
  it('maps the flux-schnell schema in x-order with resolved enum options and numeric bounds', () => {
    const fields = fieldsFromOpenApi(fluxSchnell.input, fluxSchnell.components)
    expect(fields.map((field) => field.name)).toEqual(['prompt', 'aspect_ratio', 'num_outputs', 'seed', 'go_fast'])
    expect(fields[0]).toMatchObject({ kind: 'text', multiline: true, required: true, label: 'Prompt' })
    expect(fields[1]).toMatchObject({
      kind: 'select',
      options: ['1:1', '16:9', '9:16'],
      default: '1:1',
      label: 'Aspect Ratio',
      description: 'Aspect ratio for the generated image',
    })
    expect(fields[2]).toMatchObject({ kind: 'integer', min: 1, max: 4, step: 1, default: 1 })
    expect(fields[4]).toMatchObject({ kind: 'boolean', default: true })
  })

  it('treats a nullable uri as an optional image input and orders unordered fields by key after ordered ones', () => {
    const fields = fieldsFromOpenApi(fluxKontextPro.input, fluxKontextPro.components)
    expect(fields.map((field) => field.name)).toEqual(['prompt', 'aspect_ratio', 'seed', 'input_image', 'safety_tolerance'])
    expect(fields.find((field) => field.name === 'input_image')).toMatchObject({
      kind: 'image',
      nullable: true,
      required: false,
    })
  })

  it('maps an array of uris to a multi-image input, ignoring an empty anyOf', () => {
    const fields = fieldsFromOpenApi(nanoBanana, {})
    expect(fields[1]).toMatchObject({ name: 'image_input', kind: 'images', default: [] })
  })

  it('falls back to a JSON field for cyclic, prototype, external, and multi-part references', () => {
    const fields = fieldsFromOpenApi(
      {
        properties: {
          cyclic: { $ref: '#/components/schemas/Loop' },
          proto: { allOf: [{ $ref: '#/components/schemas/constructor' }] },
          external: { $ref: 'https://evil.example/schema.json' },
          multi: { allOf: [{ $ref: '#/components/schemas/Loop' }, { type: 'string' }] },
          object: { type: 'object' },
        },
      },
      { Loop: { $ref: '#/components/schemas/Loop' } },
    )
    expect(fields.map((field) => field.kind)).toEqual(['json', 'json', 'json', 'json', 'json'])
  })

  it('skips prototype property names so model input cannot alter object prototypes', () => {
    const schema = JSON.parse('{"properties":{"__proto__":{"type":"string"},"prompt":{"type":"string"}}}')
    const fields = fieldsFromOpenApi(schema, {})
    expect(fields.map((field) => field.name)).toEqual(['prompt'])
    const input = toProviderInput(fields, JSON.parse('{"prompt":"hi","__proto__":{"polluted":true}}'))
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype)
    expect(input).toEqual({ prompt: 'hi' })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('caps the field count so a hostile schema cannot build an unbounded form', () => {
    const properties = Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`f${index}`, { type: 'string' }]))
    expect(fieldsFromOpenApi({ properties }, {})).toHaveLength(MAX_FORM_FIELDS)
  })

  it('caps select options and trims long descriptions', () => {
    const fields = fieldsFromOpenApi(
      {
        properties: {
          choice: { type: 'string', enum: Array.from({ length: 300 }, (_, index) => `o${index}`) },
          note: { type: 'string', description: 'd'.repeat(5000) },
        },
      },
      {},
    )
    expect(fields[0].kind === 'select' && fields[0].options).toHaveLength(200)
    expect(fields[1].description).toHaveLength(2000)
  })

  it('marks password fields and token-named strings secret, and storableInput never keeps them', () => {
    const fields = fieldsFromOpenApi(
      {
        required: ['prompt'],
        properties: {
          prompt: { type: 'string' },
          openai_api_key: { type: 'string', format: 'password' },
          hf_token: { type: 'string' },
          max_tokens: { type: 'integer' },
        },
      },
      {},
    )
    const secret = Object.fromEntries(fields.map((field) => [field.name, field.secret]))
    expect(secret).toEqual({ prompt: false, openai_api_key: true, hf_token: true, max_tokens: false })
    const input = toProviderInput(fields, { prompt: 'cat', openai_api_key: 'sk-live', hf_token: 'hf_x', max_tokens: 5 })
    const stored = storableInput(fields, input)
    expect(stored.input).toEqual({ prompt: 'cat', max_tokens: 5 })
    expect(stored.secretFields.sort()).toEqual(['hf_token', 'openai_api_key'])
    expect(JSON.stringify(stored)).not.toContain('sk-live')
  })

  it('returns no fields for a schema that is not an object', () => {
    expect(fieldsFromOpenApi(null, null)).toEqual([])
    expect(fieldsFromOpenApi({ properties: [] }, {})).toEqual([])
  })
})
