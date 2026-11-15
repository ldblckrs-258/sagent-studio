import { isSensitiveKey } from '../tools/redact'
import { FORBIDDEN_KEYS } from '../vault/settings'
import type { FormField, FormFieldShape } from './types'

export const MAX_FORM_FIELDS = 64
export const MAX_SELECT_OPTIONS = 200
export const MAX_SCHEMA_TEXT = 2000

type Schema = Record<string, unknown>

const REF_PATTERN = /^#\/components\/schemas\/([^/]+)$/
const MULTILINE_NAMES = new Set(['prompt', 'negative_prompt'])

function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.length > MAX_SCHEMA_TEXT ? trimmed.slice(0, MAX_SCHEMA_TEXT) : trimmed
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function humanize(name: string): string {
  return name
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ')
}

function resolveRef(ref: unknown, components: Schema): Schema | null {
  if (typeof ref !== 'string') return null
  const match = REF_PATTERN.exec(ref)
  if (!match) return null
  const name = match[1]
  if (FORBIDDEN_KEYS.has(name) || !Object.hasOwn(components, name)) return null
  const target = components[name]
  if (!isSchema(target) || '$ref' in target || 'allOf' in target) return null
  return target
}

function mergeResolved(target: Schema, property: Schema, key: string): Schema {
  const merged: Schema = { ...target, ...property }
  delete merged[key]
  return merged
}

function resolveSchema(property: Schema, components: Schema): Schema | null {
  if ('$ref' in property) {
    const target = resolveRef(property.$ref, components)
    return target ? mergeResolved(target, property, '$ref') : null
  }
  if ('allOf' in property) {
    const allOf = property.allOf
    if (!Array.isArray(allOf) || allOf.length !== 1 || !isSchema(allOf[0])) return null
    const target = resolveRef(allOf[0].$ref, components)
    return target ? mergeResolved(target, property, 'allOf') : null
  }
  return property
}

function selectOptions(values: unknown[]): (string | number)[] {
  const options: (string | number)[] = []
  for (const value of values) {
    if (options.length >= MAX_SELECT_OPTIONS) break
    if (typeof value === 'number' && Number.isFinite(value)) options.push(value)
    else if (typeof value === 'string' && value.length <= MAX_SCHEMA_TEXT) options.push(value)
  }
  return options
}

function shapeOf(name: string, schema: Schema | null): FormFieldShape {
  if (!schema) return { kind: 'json' }
  const type = schema.type
  if (type === 'string' && schema.format === 'uri') return { kind: 'image' }
  if (type === 'array') {
    const items = schema.items
    if (isSchema(items) && items.type === 'string' && items.format === 'uri') return { kind: 'images' }
    return { kind: 'json' }
  }
  if ((type === 'string' || type === 'integer' || type === 'number') && Array.isArray(schema.enum)) {
    const options = selectOptions(schema.enum)
    return options.length > 0 ? { kind: 'select', options } : { kind: 'json' }
  }
  if (type === 'integer' || type === 'number') {
    return {
      kind: type,
      min: finite(schema.minimum),
      max: finite(schema.maximum),
      step: type === 'integer' ? 1 : 0.01,
    }
  }
  if (type === 'boolean') return { kind: 'boolean' }
  if (type === 'string') return { kind: 'text', multiline: MULTILINE_NAMES.has(name) }
  return { kind: 'json' }
}

export function fieldsFromOpenApi(inputSchema: unknown, components: unknown): FormField[] {
  if (!isSchema(inputSchema) || !isSchema(inputSchema.properties)) return []
  const properties = inputSchema.properties
  const schemas = isSchema(components) ? components : {}
  const required = new Set(
    Array.isArray(inputSchema.required) ? inputSchema.required.filter((name) => typeof name === 'string') : [],
  )
  const entries: { field: FormField; order: number | undefined; index: number }[] = []
  Object.keys(properties).forEach((name, index) => {
    if (FORBIDDEN_KEYS.has(name)) return
    const property = properties[name]
    if (!isSchema(property)) return
    const schema = resolveSchema(property, schemas)
    const shape = shapeOf(name, schema)
    const secret =
      schema?.format === 'password' || (shape.kind === 'text' && isSensitiveKey(name))
    const field = {
      ...shape,
      name,
      label: text(property.title) ?? humanize(name),
      description: text(property.description),
      required: required.has(name),
      default: schema?.default,
      nullable: schema?.nullable === true,
      secret,
    } as FormField
    if (field.description === undefined) delete field.description
    if (field.default === undefined) delete field.default
    entries.push({ field, order: finite(property['x-order']), index })
  })
  entries.sort((a, b) => {
    if (a.field.name === 'prompt') return -1
    if (b.field.name === 'prompt') return 1
    if (a.order !== undefined && b.order !== undefined) return a.order - b.order || a.index - b.index
    if (a.order !== undefined) return -1
    if (b.order !== undefined) return 1
    return a.index - b.index
  })
  return entries.slice(0, MAX_FORM_FIELDS).map((entry) => entry.field)
}
