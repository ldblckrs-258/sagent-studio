# Plans

Four plans for sagent-studio. Core infrastructure ships first; the RAG pipeline
and the core chat engine both build on the shared vault, settings store, and SDK
factories, and the chat interface builds on the chat engine.

## Index

| # | Plan | Status | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| 1 | [Core infra + encrypted vault](./260918-1209-core-infra-vault/plan.md) | implemented | — | Vault unlock + persisted encrypted config + both SDK factories usable |
| 2 | [RAG + TypeSafe pipeline](./260918-1210-rag-typesafe-pipeline/plan.md) | blocked | Plan 1 | Query returns grounded answer with gating, injection filter, citation check |
| 3 | [Core chat engine](./260919-0828-core-chat-engine/plan.md) | implemented (two manual gates pending) | Plan 1 | Streaming tool-using engine with editable history, skills, workspace tools, sandboxed runners |
| 4 | [Chat interface](./260919-1437-chat-interface/plan.md) | implemented (browser gates pending) | Plan 3 | Three-column assistant-ui shell: workspace-grouped conversations, streaming thread with edit/rerun, workspace/file/chat-config/skills/tools/sandbox panels |

## Sequencing

Plan 2 must not start before Plan 1 satisfies its acceptance criteria. Plan 2's
phase files are authored after Plan 1 lands, because the vault and provider
interfaces it consumes are fixed there. Plan 2's README records the intended
phases, requirements, and risks so the dependency is visible now.

Plan 3 consumes Plan 1's frozen `createLLM` and vault interfaces and is additive
to them. It is implemented; two browser-only gates remain deferred (the Chromium
folder picker/re-grant and a real-provider engine turn). Evidence and review
dispositions are in
[`journals/2026-09-19-implemented-core-chat-engine.md`](./journals/2026-09-19-implemented-core-chat-engine.md).

Plan 1 is implemented and its frozen interfaces are final. Two release checks are
deferred and do not block interface work: the live `systemOne` browser call needs a
real TypeSafe key, and the CSP has only been verified in the built HTML, not in a
running browser. `pnpm test`, `pnpm lint`, and `pnpm build` all pass.

Plan 4 consumes Plan 3's engine, stores, registries, workspace, and runners
without changing their contracts beyond the additive changes its phases record
(destructive edit, `ChatEngine.dispose()`, active-run accounting, idempotent
hydrate, a runner-source code provider, `ThreadSummary` title/workspace, and
`Settings.skills`/`Settings.sandbox`). It is implemented; the node gates
(`pnpm test`, `pnpm lint`, `pnpm build`) pass and every browser-only gate is
recorded as pending in
[`journals/2026-09-19-implemented-chat-interface.md`](./journals/2026-09-19-implemented-chat-interface.md).
Its accepted contract, red-team findings, and validation decisions are in
[`260919-1437-chat-interface/plan.md`](./260919-1437-chat-interface/plan.md).

## Source of truth

Contract, verified environment evidence, approach comparison, chosen architecture,
and unresolved risks live in
[`260918-1209-core-infra-vault/reports/brainstorm-260918-1907-client-side-rag-typesafe-vault.md`](./260918-1209-core-infra-vault/reports/brainstorm-260918-1907-client-side-rag-typesafe-vault.md).
