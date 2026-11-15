import { isSensitiveKey } from '../tools/redact'
import type { FormField } from './types'

export type FormValues = Record<string, unknown>

export class FormInputError extends Error {
  readonly field: string

  constructor(field: string, message: string) {
    super(message)
    this.name = 'FormInputError'
    this.field = field
  }
}

export class InputJsonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InputJsonError'
  }
}

export function initialValues(fields: readonly FormField[]): FormValues {
  return Object.fromEntries(fields.map((field) => [field.name, field.secret ? undefined : field.default]))
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

function clamp(value: number, min: number | undefined, max: number | undefined): number {
  let next = value
  if (min !== undefined && next < min) next = min
  if (max !== undefined && next > max) next = max
  return next
}

function coerce(field: FormField, raw: unknown): unknown {
  switch (field.kind) {
    case 'text':
      return isBlank(raw) ? undefined : String(raw)
    case 'select': {
      if (isBlank(raw)) return undefined
      const option = field.options.find((candidate) => String(candidate) === String(raw))
      if (option === undefined) throw new FormInputError(field.name, `${field.label} has no option "${String(raw)}".`)
      return option
    }
    case 'integer':
    case 'number': {
      if (isBlank(raw)) return undefined
      const parsed = Number(raw)
      if (!Number.isFinite(parsed)) throw new FormInputError(field.name, `${field.label} must be a number.`)
      return clamp(field.kind === 'integer' ? Math.round(parsed) : parsed, field.min, field.max)
    }
    case 'boolean':
      return typeof raw === 'boolean' ? raw : undefined
    case 'image':
      return typeof raw === 'string' && raw !== '' ? raw : undefined
    case 'images': {
      if (!Array.isArray(raw)) return undefined
      const urls = raw.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
      return urls.length > 0 ? urls : undefined
    }
    case 'json': {
      if (isBlank(raw)) return undefined
      if (typeof raw !== 'string') return raw
      try {
        return JSON.parse(raw) as unknown
      } catch {
        throw new FormInputError(field.name, `${field.label} is not valid JSON.`)
      }
    }
  }
}

export function toProviderInput(fields: readonly FormField[], values: FormValues): Record<string, unknown> {
  const input = Object.create(null) as Record<string, unknown>
  for (const field of fields) {
    const raw = Object.hasOwn(values, field.name) ? values[field.name] : undefined
    const value = coerce(field, raw)
    if (value === undefined) {
      if (field.required) throw new FormInputError(field.name, `${field.label} is required.`)
      continue
    }
    input[field.name] = value
  }
  return { ...input }
}

export function storableInput(
  fields: readonly FormField[],
  input: Record<string, unknown>,
): { input: Record<string, unknown>; secretFields: string[] } {
  const secrets = new Set(fields.filter((field) => field.secret).map((field) => field.name))
  const declared = new Set(fields.map((field) => field.name))
  const stored = Object.create(null) as Record<string, unknown>
  const secretFields: string[] = []
  for (const [name, value] of Object.entries(input)) {
    if (secrets.has(name) || (!declared.has(name) && isSensitiveKey(name))) secretFields.push(name)
    else stored[name] = value
  }
  return { input: { ...stored }, secretFields }
}

export function imageFields(fields: readonly FormField[]): FormField[] {
  return fields.filter((field) => field.kind === 'image' || field.kind === 'images')
}

function isImageKind(field: FormField): boolean {
  return field.kind === 'image' || field.kind === 'images'
}

function isImageRef(value: unknown): boolean {
  const refs = Array.isArray(value) ? value : [value]
  return (
    refs.length > 0 &&
    refs.every((entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry) && '$image' in entry)
  )
}

export function draftInput(fields: readonly FormField[], values: FormValues): Record<string, unknown> {
  const draft = Object.create(null) as Record<string, unknown>
  for (const field of fields) {
    if (isImageKind(field)) continue
    try {
      const value = coerce(field, Object.hasOwn(values, field.name) ? values[field.name] : undefined)
      if (value !== undefined) draft[field.name] = value
    } catch {
      continue
    }
  }
  return { ...draft }
}

export function editableInput(fields: readonly FormField[], input: Record<string, unknown>): Record<string, unknown> {
  const images = new Set(fields.filter(isImageKind).map((field) => field.name))
  const editable = Object.create(null) as Record<string, unknown>
  for (const [name, value] of Object.entries(input)) {
    if (images.has(name) && isImageRef(value)) continue
    editable[name] = value
  }
  return { ...editable }
}

function formValue(field: FormField, value: unknown): { value: unknown } | null {
  switch (field.kind) {
    case 'json':
      return { value: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
    case 'boolean':
      return typeof value === 'boolean' ? { value } : null
    case 'text':
    case 'select':
    case 'integer':
    case 'number':
      return typeof value === 'string' || typeof value === 'number' ? { value } : null
    case 'image':
    case 'images':
      return null
  }
}

export function valuesFromInput(
  fields: readonly FormField[],
  input: Record<string, unknown>,
): { values: FormValues; dropped: string[] } {
  const byName = new Map(fields.map((field) => [field.name, field]))
  const values: FormValues = Object.fromEntries(fields.map((field) => [field.name, undefined]))
  const dropped: string[] = []
  for (const [name, value] of Object.entries(input)) {
    const field = byName.get(name)
    if (field && isImageKind(field) && isImageRef(value)) continue
    const mapped = field ? formValue(field, value) : null
    if (mapped) values[name] = mapped.value
    else dropped.push(name)
  }
  return { values, dropped }
}

export function parseInputJson(text: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : ''
    throw new InputJsonError(`The JSON input is not valid.${detail}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InputJsonError('The JSON input must be an object, for example {"prompt": "a cat"}.')
  }
  return parsed as Record<string, unknown>
}
