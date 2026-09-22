# Revision — `search_documents` result trust boundary

Date: 2026-09-22. Trigger: user review of the tool result shape.

The phase 4 plan specified a rich `search_documents` result carrying
orchestration telemetry (`usage`, `embedProviderId`, `embedModel`, `jevModel`,
`mode`, `routed.*`, `excluded`/`injectionExcluded`/`failed`, `score`, `rerank`)
and a behavioural `directive`. Review found two problems:

1. **Telemetry in the data channel.** Those fields are pipeline state, not
   evidence. The model reads the tool result as facts, so counts, scores, ranks,
   and provider/model identities leak into its reasoning and are redundant.
2. **Instruction in the data channel.** `directive` told the model how to behave
   (report conflicts, verify quotations). Putting instructions in the untrusted
   data channel is a trust-boundary error, worse than the numeric leak.

## Decision (user-approved)

The model-visible result is reduced to what is needed to answer and cite:

```
RagSearchResult {
  query: string
  passages: { id, docTitle, ordinal, text }[]
  conflicting: { id, docTitle, ordinal, text }[]
  injectionWithheld: boolean
  untrustedNotice: string
}
```

- Removed from the model channel: `usage`, provider/model ids, `dims`, `mode`,
  `routed.*`, `excluded`, `injectionExcluded`, `failed`, `score`, `rerank`,
  `selectedQuery`, `skipped`, `directive`.
- Kept a safety signal only: `injectionWithheld` is a boolean, not a count.
- Moved the behavioural rules into the system prompt (`RAG_GUIDANCE` in
  `src/chat/context.ts`): untrusted passages, report conflicts, empty result
  means no relevant passage, verify citations with `verify_citation`, cite
  `id`/`docTitle`.
- `list_documents` no longer exposes `dims` (embedding width). The Documents
  panel still shows dimensions from its own store, not the tool.
- Usage accounting stays internal (`jevsUsage`) for ops; it is no longer returned.

## Files

- `src/rag/port.ts` — result types, `emptyResult`, `buildPassage`, `search`.
- `src/tools/builtin/rag.ts` — tool description.
- `src/tools/builtin/guides/rag.md` — result field reference.
- `src/chat/context.ts` — `RAG_GUIDANCE` now owns the behavioural rules.
- `src/components/assistant-ui/elements/rag-citations.aui.tsx` — card shows
  passages, conflicts, and the withheld flag; no counts/scores/mode.
- Tests: `src/tools/builtin/rag.test.ts`, `src/rag/rag-e2e.test.ts` assert the
  telemetry fields are absent and the marker is never echoed.

`pnpm test`, `pnpm lint`, and `pnpm build` pass.
