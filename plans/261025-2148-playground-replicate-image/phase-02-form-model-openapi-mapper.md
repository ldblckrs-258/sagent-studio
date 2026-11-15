---
phase: 2
title: Form model and OpenAPI mapper
status: completed
priority: P2
effort: 3h
dependencies: [1]
---

# Phase 2 — Form model and OpenAPI mapper

## Goal

A provider-neutral form model describes model inputs. A hardened mapper turns an untrusted OpenAPI input schema into that model, so any provider whose models publish OpenAPI schemas can reuse it.

## Files

- Create:
  - `src/playground/form.ts`
  - `src/playground/openapi-form.ts`
- Modify:
  - `src/tools/redact.ts`: export `isSensitiveKey` (`:32`).
- Tests:
  - `src/playground/form.test.ts`
  - `src/playground/openapi-form.test.ts`

## Steps

1. **Form model (`form.ts`).**
   - Works on `FormField` from `src/playground/types.ts` (phase 1).
   - `initialValues(fields)`: each field's `default`, else `undefined`; secret fields always start empty.
   - `toProviderInput(fields, values)`:
     - builds the result with `Object.create(null)` and copies into a plain object at the end;
     - omits `undefined`, empty optional strings, and empty arrays;
     - coerces and clamps `integer` and `number`;
     - parses `json` fields and throws `FormInputError(name, message)` on invalid JSON;
     - throws `FormInputError` for a missing required field, including an empty secret.
   - `storableInput(fields, input)` returns the input without secret fields, plus `secretFields: string[]`.
   - `imageFields(fields)` returns the `image` and `images` fields.
2. **OpenAPI mapper (`openapi-form.ts`).** `fieldsFromOpenApi(inputSchema, components)`:
   - Property names are read with `Object.keys` and skipped when they are in `FORBIDDEN_KEYS` (`src/vault/settings.ts:216`; export it if needed).
   - `$ref` resolution accepts only `#/components/schemas/<name>`, looks up `<name>` with `Object.hasOwn`, and resolves one level. An `allOf` with one `$ref` is the enum case. Anything deeper, cyclic, or unresolvable becomes `json`.
   - Caps: at most 64 fields and 200 enum options; extra fields are dropped and extra options truncated. Strings for `title`, `description`, and enum labels are trimmed to 2,000 characters.
   - Kind mapping: string with `format: uri` is `image`; array whose `items` has `format: uri` is `images` (an empty `anyOf: []` in `items` is ignored); string or integer with `enum` is `select`; `integer` and `number` keep `minimum` and `maximum`; `boolean`; string is `text`, multiline when the name is `prompt` or `negative_prompt`; anything else is `json`.
   - `secret` is true for `format: password` or when `isSensitiveKey(name)` is true.
   - Ordering: by `x-order`, then key order for fields without it; `prompt` first.

## Verification

- `pnpm exec vitest run src/playground/form.test.ts src/playground/openapi-form.test.ts`
- Fixtures from `plans/reports/researcher-261025-2142-replicate-http-api.md`:
  - flux-schnell: ordering, `aspect_ratio` select with default `1:1`, `num_outputs` integer 1–4, `go_fast` boolean;
  - flux-kontext-pro: nullable `input_image` as `image`, key-order fallback;
  - nano-banana: `image_input` as `images`;
  - an `allOf` / `$ref` enum resolved; a cyclic `$ref`, a `$ref` to `constructor`, and an external `$ref` all fall back to `json`;
  - a property named `__proto__` is skipped and `toProviderInput` output has a normal prototype;
  - 70 properties produce 64 fields;
  - `openai_api_key` (`format: password`) and a plain `hf_token` string are both `secret`, and `storableInput` drops them;
  - `toProviderInput` clamping, required errors, and invalid JSON errors.
