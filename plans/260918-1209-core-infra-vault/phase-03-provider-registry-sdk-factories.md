---
title: "Phase 3: Provider Registry + SDK Factories"
status: todo
---

# Phase 3: Provider Registry + SDK Factories

## Context Links

- [Plan overview](./plan.md)
- [Phase 2: Settings Store + Vault Shell](./phase-02-settings-store-vault-shell.md)
- [Brainstorm source](./reports/brainstorm-260918-1907-client-side-rag-typesafe-vault.md)

## Overview

- **Priority:** P1 (final core-infra phase; the RAG plan consumes its output)
- **Status:** todo
- **Description:** Reusable, UI-agnostic factories that turn decrypted provider settings
  into a working AI SDK language model and a configured TypeSafe client, plus the
  provider CRUD panel and data-egress notice.

This phase carries the project's load-bearing browser-assumption test: a live
`systemOne` call from the Vite bundle. Resolve it here before Plan 2 starts.

## Key Insights

- `@ai-sdk/openai-compatible` is not yet installed. It covers custom base URLs for
  OpenAI, Groq, Ollama, and local servers without a per-vendor package.
- **Verified API:** `createOpenAICompatible({ baseURL, name, apiKey })` returns a
  provider exposing `.chatModel(modelId)`. `ai@7` also exports `createProviderRegistry`
  and `customProvider`.
- **Verified version note:** `@ai-sdk/openai-compatible@3.0.52` declares
  `@ai-sdk/provider@4.0.17` and `@ai-sdk/provider-utils@5.0.44`, while the installed
  `ai@7.0.105` resolves `@ai-sdk/provider-utils@5.0.43`. The drift is one minor. Pin
  the provider exactly and force a build that imports both `ai` and the factory in one
  module so a mismatch fails at install time, not at the browser gate.
- `TypeSafeClient` refuses to construct in a browser without
  `dangerouslyAllowBrowser: true`. **Verified at**
  `node_modules/@typesafe-ai/sdk/dist/index.mjs:511`. The package publishes only
  `dist/`, `LICENSE`, and `README.md` — no `src/` — so SDK-source citations must target
  the bundled ESM.
- The TypeSafe SDK logs the **request body** (query text and document chunks)
  unredacted at `debug` level. `createTypeSafe` must pin `logLevel: 'warn'` explicitly
  rather than relying on the env-resolved default.
- Factories take an explicit settings snapshot. They must not reach into the Zustand
  store, or they stop being pure and Phase 3 reintroduces the coupling this phase
  forbids.
- `@typesafe-ai/sdk` is ESM with TypeScript declarations; the default model is
  `jev-latest`, overridable per call or via `defaultModel`.

## Frozen Interfaces

These signatures are authoritative. Plan 2 consumes them verbatim; do not change one
without updating `plans/260918-1210-rag-typesafe-pipeline/plan.md`.

```ts
createLLM(settings: Settings, providerId: string, modelOverride?: string): LanguageModel
createTypeSafe(settings: Settings): TypeSafeClient
```

## Requirements

### Functional

- Add `@ai-sdk/openai-compatible`, pinned to an exact version.
- `createLLM(settings, providerId, modelOverride?)` resolves a provider from the
  snapshot and returns a language model bound to its `baseURL`, `apiKey`, and model.
- `createTypeSafe(settings)` reads the TypeSafe key and model from the snapshot, passes
  `dangerouslyAllowBrowser: true`, and pins `logLevel: 'warn'`.
- Provider CRUD: add, edit, delete, set default, and select a model per provider.
- Secret fields render masked and are populated only on an explicit reveal action;
  they are never bound from the settings snapshot by default.
- A connection test that issues one small completion and reports success or a typed error.
- A persistent, dismissible notice that query text and document chunks are sent to
  TypeSafe and the selected LLM provider.
- Typed configuration errors rather than `undefined` or a runtime crash.
- A strict Content-Security-Policy, documented and verified in the browser smoke test.

### Non-functional

- No React import inside `src/ai/`; factories are testable without a DOM.
- Memoized client instances are keyed off the store's `unlockGeneration` so `lock()`
  discards them; no key survives a lock.
- No key written to logs at any log level.
- Provider secrets live only in the encrypted settings blob from Phase 2.

## Architecture

```
settings snapshot (decrypted, in memory)
  │
  ├─ providers[] ──▶ resolveProvider(id) ──▶ createOpenAICompatible({ baseURL, name, apiKey })
  │                                              └─▶ .chatModel(modelId) : LanguageModel
  │
  └─ typesafe ─────▶ createTypeSafe(settings) ──▶ new TypeSafeClient({
                                                 apiKey, defaultModel,
                                                 logLevel: 'warn',
                                                 dangerouslyAllowBrowser: true
                                               })

Memoization: clients are cached against `unlockGeneration`. When `lock()` increments
it, the cache is discarded and no authenticated client survives the lock.
```

Both factories read a plain settings object, so they can be called from React, a
worker, or a test without further setup.

## Related Code Files

**Create**

- `src/ai/providers.ts` — `ProviderConfig` type, validation, defaults, `resolveProvider`.
- `src/ai/llm.ts` — `createLLM`, `LLMConfigError`.
- `src/ai/typesafe.ts` — `createTypeSafe`, `TypeSafeConfigError`.
- `src/ai/client-cache.ts` — memoization keyed by `unlockGeneration`.
- `src/ai/llm.test.ts` — factory tests against a settings snapshot.
- `src/ai/typesafe.test.ts` — client construction, `logLevel`, and config error tests.
- `src/settings/ProvidersPanel.tsx` — provider CRUD, TypeSafe key form, connection test.
- `src/settings/DataEgressNotice.tsx` — persistent dismissible egress notice.
- `src/ai/secret-field.tsx` — masked, reveal-on-demand secret input.

**Modify**

- `src/App.tsx` — mount the providers panel and the egress notice when unlocked.
- `src/vault/settings.ts` — ensure `ProviderConfig` and `typesafe` shapes match `src/ai/providers.ts`.
- `package.json` — add `@ai-sdk/openai-compatible` pinned exactly (for example `"3.0.52"`).
- `index.html` — add the strict CSP meta tag.

**Delete**

- None.

## Implementation Steps

1. Install `@ai-sdk/openai-compatible` pinned to an exact version, and add a
   temporary module that imports both `ai` and `createOpenAICompatible` so
   `pnpm build` fails immediately on a provider-utils mismatch.
2. Define `ProviderConfig { id, label, kind: 'openai-compatible', baseURL, apiKey, models: string[], defaultModel }`
   in `src/ai/providers.ts`, with `validateProvider` returning typed field errors and
   caps on provider count and model-list length.
3. Implement `resolveProvider(settings, providerId)` returning the `ProviderConfig` or
   throwing `LLMConfigError` when missing or invalid.
4. Implement `createLLM(settings, providerId, modelOverride?)` using
   `createOpenAICompatible({ baseURL, name, apiKey })` and `.chatModel(model)`.
5. Implement `createTypeSafe(settings)` returning a `TypeSafeClient` with the resolved
   key, `defaultModel` from settings, `logLevel: 'warn'`, and
   `dangerouslyAllowBrowser: true`.
6. Implement `src/ai/client-cache.ts`: cache `LanguageModel` and `TypeSafeClient`
   instances against `unlockGeneration`. Export `invalidate()` and call it from the
   store's `lock()` path.
7. Build `src/ai/secret-field.tsx`: masked input, reveal button, never populated from
   the snapshot unless the user reveals it.
8. Build `ProvidersPanel` with add, edit, delete, set-default, and per-provider model
   list editing. Persist through the Phase 2 `update(patch)`; debounce writes so a
   form does not persist per keystroke.
9. Add a connection test button that calls `createLLM(...)` and issues one minimal
   completion, surfacing a typed success or failure without echoing the key.
10. Build `DataEgressNotice` with a short, explicit statement that query text and
    document chunks leave the device for TypeSafe and the LLM provider. Persist
    dismissal in settings.
11. Add the TypeSafe key and model form, including an optional base URL override.
12. Add the strict CSP meta tag to `index.html` (`default-src 'self'`, `script-src 'self'`,
    `connect-src` allowlisting the configured provider origins), and document it as a
    deployment requirement. This is not optional given keys live in browser memory.
13. Write tests: `createLLM` returns a model for a valid provider; throws
    `LLMConfigError` for a missing or invalid one; `createTypeSafe` constructs with a
    valid config, pins `logLevel`, and throws otherwise; a spy logger never receives a
    request body; `invalidate()` empties the cache.
14. Smoke-test in the browser: construct `TypeSafeClient` under the Vite bundle and run
    one `systemOne` call with a trivial `noul` question. Record the outcome in
    `plan.md`'s validation log as a manual, credential-dependent check — not as a CI
    acceptance criterion.

## Todo

- [ ] Install `@ai-sdk/openai-compatible` at an exact pinned version
- [ ] Define `ProviderConfig` and validation with caps
- [ ] Implement `resolveProvider` and `LLMConfigError`
- [ ] Implement `createLLM(settings, providerId, modelOverride?)`
- [ ] Implement `createTypeSafe(settings)` with `logLevel: 'warn'`
- [ ] Implement the `unlockGeneration`-keyed client cache
- [ ] Build the masked secret field
- [ ] Build the providers CRUD panel with debounced writes
- [ ] Add the connection test
- [ ] Build the data-egress notice
- [ ] Add the strict CSP and document the deployment requirement
- [ ] Write factory, logLevel, cache-invalidation, and DOM-masking tests
- [ ] Browser-smoke-test a live `systemOne` call under Vite and record it

## Success Criteria

- A configured provider yields a working language model and produces a real completion.
- `createTypeSafe(settings)` constructs in the browser and completes one live `systemOne` call
  (recorded as a manual validation, not a CI gate).
- Invalid or missing provider configuration raises a typed error, never `undefined`.
- Adding, editing, and deleting providers persists across reload via the encrypted store.
- No request or response body reaches a configured logger; `logLevel` is pinned to `warn`.
- After `lock()`, the client cache is empty and no authenticated client is reachable.
- A saved key is not present in the DOM until the user explicitly reveals it; an
  automated test asserts the masked field does not contain the seeded key after unlock.
- The CSP meta tag is present and the app runs under it without violations.
- `pnpm test`, `pnpm lint`, `pnpm build` all pass.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| `dangerouslyAllowBrowser` fails under the Vite bundle | Medium | High | The browser smoke test is the first gate; if it fails, re-scope Plan 2 against a server proxy before building UI |
| Provider package minor drift from `ai@7` | Medium | High | Install with an exact pin; a combined import forces the mismatch to fail at build time |
| Secrets rendered into DOM inputs | High | High | Masked `secret-field` with reveal-on-demand; automated DOM test |
| Keys surviving lock in memoized clients | Medium | High | Cache keyed by `unlockGeneration`; `invalidate()` called from `lock()`; tested |
| TypeSafe SDK logging request bodies | Medium | High | Pin `logLevel: 'warn'` and pass a logger that cannot be re-enabled by env; spy-logger test |
| XSS exfiltrating in-memory keys | Medium | Critical | Strict CSP plus a no-`dangerouslySetInnerHTML` rule carried into the Plan 2 handoff |
| Per-keystroke writes amplifying the settings race | Medium | Medium | Debounce persist in the panel; the Phase 2 queue serializes the actual writes |

## Security Considerations

- The egress notice must be shown before the first API call, not buried in settings.
- `dangerouslyAllowBrowser: true` is a deliberate accepted risk for a local/personal
  app. The CSP is the compensating control; a public deployment requires a server proxy.
- Keys are read from the decrypted snapshot only at call time and never cached globally
  beyond the `unlockGeneration` cache.
- Connection-test errors must not echo the key back into the UI.
- Secrets are masked in the DOM and populated only on explicit user reveal.

## Next Steps

This is the last core-infra phase. On completion, Plan 1 satisfies its acceptance
criteria and the RAG pipeline plan can begin consuming the frozen interfaces above.
Record the browser smoke-test result in `plan.md` before handing off.
