---
type: research
date: 2026-10-25
topic: Replicate HTTP API for a browser client behind a same-origin proxy
---

# Replicate HTTP API

## Summary

Every call the playground needs is a plain JSON or multipart HTTP request against `https://api.replicate.com/v1`. Official models run by `owner/name` without a version; other models need a version id. `Prefer: wait=N` (N ≤ 60) holds the request open, then the client polls. Outputs live on `replicate.delivery` for one hour; a preflight there returned `access-control-allow-origin: *`. Sources: the [HTTP reference](https://replicate.com/docs/reference/http), the live spec at `https://api.replicate.com/openapi.json`, model `/api/schema` pages, and unauthenticated curl probes.

The token belongs to the user and is sent from the browser in `Authorization: Bearer <token>`. The proxy only relays it.

## Endpoints

| Purpose | Request | Notes |
|---------|---------|-------|
| Token check | `GET /v1/account` | Returns `type`, `username`, `name`. Cheapest auth check. |
| Model and schema | `GET /v1/models/{owner}/{name}` | `is_official`, `description`, `cover_image_url`, `latest_version` (nullable). Input schema at `latest_version.openapi_schema.components.schemas.Input`, output at `...Output`. The version id field is `latest_version.id` (UNVERIFIED on a live authenticated response). |
| Run official model | `POST /v1/models/{owner}/{name}/predictions` body `{ input }` | Use when `is_official` is true. |
| Run any model | `POST /v1/predictions` body `{ version, input }` | `version` accepts `owner/name` (official only), `owner/name:<id>`, or a bare 64-char id. `additionalProperties: false`. |
| Poll | `GET /v1/predictions/{id}` | |
| Cancel | `POST /v1/predictions/{id}/cancel` | 200. |
| Upload | `POST /v1/files` multipart, file field `content`, optional `filename`, `type` | 201 with `urls.get`. Pass `urls.get` as the input value. 413 above 100 MB. |

The prediction's `urls.get` and `urls.cancel` are absolute `https://api.replicate.com/...` URLs and must be rewritten to the proxy base before use.

## `Prefer: wait`

- `Prefer: wait` or `Prefer: wait=N` with N in 1–60; bare `wait` is 60 s.
- On timeout the response is an unfinished prediction (`starting` or `processing`); the prediction keeps running. Branch on `status`, not on 201 vs 202.
- Poll every 1–2 s. `Cancel-After` (5 s–24 h) caps run time server-side.

## Prediction object

- Status: `starting`, `processing`, `succeeded`, `failed`, `canceled`, `aborted`. The last four are terminal.
- Fields: `id`, `model`, `version`, `input`, `output`, `logs`, `error` (string or null), `status`, `created_at`, `started_at`, `completed_at`, `data_removed`, `metrics` (`predict_time`, `total_time` when finished), `urls`.
- `output` is model-defined: a uri string, an array of uri strings, or other JSON.
- API prediction inputs and outputs are removed after one hour ([data retention](https://replicate.com/docs/topics/predictions/data-retention)).

## Input files

- Data URIs are recommended for small files. The spec says ≤ 256 KB; the [input files page](https://replicate.com/docs/topics/predictions/input-files) says under 1 MB. Use 256 KB as the threshold.
- Larger files go through `POST /v1/files` (≤ 100 MB).
- Any `format: uri` field, including arrays of uri, accepts an http(s) URL, a data URI, or a Replicate file URL.

## Output files

- Hosts: `replicate.delivery` and `*.replicate.delivery` ([output files](https://replicate.com/docs/topics/predictions/output-files)). No auth needed. Expire after one hour.
- An `OPTIONS` preflight with `Origin` returned `access-control-allow-origin: *`, `access-control-allow-methods: GET`. Whether the GET response carries the header is UNVERIFIED.

## Errors

- Format is `application/problem+json` with `title`, `detail`, `status`.
- 401 observed: `detail` "You did not pass an authentication token" or "...a valid authentication token".
- 413: "Files must be less than 100MB in size". 429: "Request was throttled. Your rate limit resets in ~30s."
- 402, 422, and model 404 bodies are UNVERIFIED. Handling: show `detail`, else `title`, else the status text.
- Rate limits: 600/min for creating predictions, 3,000/min for other calls; 6/min for accounts with only granted credit ([rate limits](https://replicate.com/docs/topics/predictions/rate-limits)).

## Input schema features seen in real models

- `x-order` (not always present; fall back to key order), `required` (usually only `prompt`), `title`, `description`, `default`.
- `enum` strings, possibly through `allOf: [{ $ref: '#/components/schemas/<name>' }]` in the raw API schema. Support both inline and `$ref` forms.
- `integer` and `number` with `minimum` and `maximum`; `boolean`; `nullable: true`.
- `format: uri` strings and `type: array` of `format: uri` for image inputs.
- `format: password` (for example `openai_api_key`).
- Empty `anyOf: []` inside array items; ignore it.

flux-schnell example (from its [schema page](https://replicate.com/black-forest-labs/flux-schnell/api/schema)):

```json
{
  "type": "object", "required": ["prompt"],
  "properties": {
    "prompt": { "type": "string", "x-order": 0 },
    "aspect_ratio": { "type": "string", "enum": ["1:1", "16:9", "21:9", "3:2", "2:3", "4:5", "5:4", "3:4", "4:3", "9:16", "9:21"], "default": "1:1", "x-order": 1 },
    "num_outputs": { "type": "integer", "default": 1, "minimum": 1, "maximum": 4, "x-order": 2 },
    "go_fast": { "type": "boolean", "default": true, "x-order": 8 }
  }
}
```

## Quick-pick models (all official)

| Model | Edits | Image input field | Output |
|-------|-------|-------------------|--------|
| `black-forest-labs/flux-schnell` | no | — | array of uri |
| `black-forest-labs/flux-kontext-pro` | yes | `input_image` (uri) | uri |
| `black-forest-labs/flux-2-pro` | yes | `input_images` (array) | uri |
| `google/nano-banana` | yes | `image_input` (array) | uri |
| `google/nano-banana-pro` | yes | `image_input` (array) | uri |
| `bytedance/seedream-4.5` | yes | `image_input` (array) | array of uri |
| `google/imagen-4` | no | — | uri |

`openai/gpt-image-1.5` has an `openai_api_key` field, so it is left out of the quick-pick list.

## Unresolved questions

1. Bodies of 402, 422, and model 404.
2. Exact `latest_version` shape on an authenticated response (version id field, raw `allOf`/`$ref` usage).
3. Whether a `replicate.delivery` GET response carries `access-control-allow-origin`.
4. Status code returned by `Prefer: wait` on timeout.
