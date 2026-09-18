# Plans

Two sequential plans for sagent-studio. Core infrastructure ships first; the RAG
pipeline builds on the shared vault, settings store, and SDK factories.

## Index

| # | Plan | Status | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| 1 | [Core infra + encrypted vault](./260918-1209-core-infra-vault/plan.md) | ready | — | Vault unlock + persisted encrypted config + both SDK factories usable |
| 2 | [RAG + TypeSafe pipeline](./260918-1210-rag-typesafe-pipeline/plan.md) | blocked | Plan 1 | Query returns grounded answer with gating, injection filter, citation check |

## Sequencing

Plan 2 must not start before Plan 1 satisfies its acceptance criteria. Plan 2's
phase files are authored after Plan 1 lands, because the vault and provider
interfaces it consumes are fixed there. Plan 2's README records the intended
phases, requirements, and risks so the dependency is visible now.

## Source of truth

Contract, verified environment evidence, approach comparison, chosen architecture,
and unresolved risks live in
[`260918-1209-core-infra-vault/reports/brainstorm-260918-1907-client-side-rag-typesafe-vault.md`](./260918-1209-core-infra-vault/reports/brainstorm-260918-1907-client-side-rag-typesafe-vault.md).
