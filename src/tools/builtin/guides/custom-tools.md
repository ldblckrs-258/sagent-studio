# Custom tools

A user tool is either `sandbox-js` (JavaScript body) or `http` (request template). `kind` is fixed at creation; `update_tool` can change every other field and renames when `name` differs from `from`.

## Both kinds
- `name` must match `^[a-zA-Z0-9_]{1,64}$` and be free: provider tools and user tools share one namespace (`conflict` when taken).
- `inputSchema` is a plain JSON Schema object. No prototypes, no `__proto__`/`constructor`/`prototype` keys, and nesting deeper than 32 levels is rejected.
- `enabled` defaults to `false` when it is omitted, and a disabled tool stays out of the tool set. Pass `enabled: true` at creation, or flip it later with `update_tool`.

## sandbox-js
The runtime prepends `const input = <arguments as JSON>;` to `source`, so read arguments from `input`. The body is an async function body: `await` at top level is fine, and `return` surfaces the result. `console` and `fs` are injected — see the `sandbox` guide for the same runtime limits as `run_js`. Optional `timeoutMs` must be a positive integer; without it the sandbox default applies.

```json
{
  "kind": "sandbox-js",
  "name": "slugify",
  "description": "Lowercase a title into a URL slug.",
  "inputSchema": { "type": "object", "properties": { "title": { "type": "string" } }, "required": ["title"] },
  "source": "return input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');",
  "enabled": true
}
```

## http
`request` needs an absolute `url` and an `allowedOrigins` list containing that URL's origin; a request to any other origin is rejected. Only `{{input.path}}` placeholders interpolate, they resolve against the tool arguments and must land on a scalar (a missing path or an object fails the call). Any other placeholder shape, such as `{{id}}`, is rejected when the tool is created or updated, because it would otherwise be sent literally. The scheme and host cannot be templated, and header names cannot either — only header values and the body can. Method must be one of GET, POST, PUT, PATCH, DELETE, HEAD. `timeoutMs` defaults to 15000 and the response body is capped at 1000000 bytes; a non-2xx status fails the call.

```json
{
  "kind": "http",
  "name": "get_repo",
  "inputSchema": { "type": "object", "properties": { "owner": { "type": "string" }, "repo": { "type": "string" } }, "required": ["owner", "repo"] },
  "request": {
    "method": "GET",
    "url": "https://api.github.com/repos/{{input.owner}}/{{input.repo}}",
    "headers": { "Accept": "application/vnd.github+json" },
    "allowedOrigins": ["https://api.github.com"]
  },
  "enabled": true
}
```

## When a tool becomes callable

A tool joins the model tool list at the start of the next turn, so a tool created, renamed, or enabled during this turn is not yet a callable tool name. Call it in this turn with `call_user_tool({ name, input })`, which resolves the stored definition when the call runs. A tool already in the list is called directly; `call_user_tool` needs approval and refuses a target the approval policy denies. Editing an existing tool takes effect immediately: the next call uses the stored definition, not the one captured when the turn started.

## Debugging
- `invalid_input`: the definition is malformed — re-check the name pattern, the schema shape, and that a `sandbox-js` tool carries `source` while an `http` tool carries `request`.
- `conflict`: the name is taken. Call `list_user_tools` and pick another.
- `http_error`: origin not allowlisted, placeholder missing from the arguments, non-2xx status, timeout, or a body over the cap.
