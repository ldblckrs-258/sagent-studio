# Phase 2 — Target-scale retrieval measurement

Fixture: 1,000 documents × 50 chunks = 50,000 encrypted chunks through the real
Dexie store and keyring, 16 dimensions per vector. Machine: Apple Silicon macOS
(darwin), Node test environment with `fake-indexeddb`.

| Metric | Observed |
| --- | --- |
| Chunks | 50,000 |
| Index mode | `resident` |
| Dimensions | 16 |
| Vector bytes | 50,000 × 16 × 4 = 3.2 MiB (well under the 128 MiB default budget) |
| Seed (encrypt + persist) | ~6,240 ms |
| Hydrate (sweep + decrypt + build index) | ~1,206 ms |
| `cosineTopK` median (7 runs, k=5) | **15.26 ms** |
| Samples | 14.24, 14.73, 14.89, 15.26, 17.67, 18.90, 20.67 ms |

The resident-mode target is well under ~150 ms median, so acceptance criterion 3
is met for the resident path. Paged mode's own median at 1,000 documents is
measured in the phase 5 browser checklist when the stored dimensions push the
vectors over `RAG_VECTOR_MEMORY_BUDGET_BYTES`.

## Performance note discovered during measurement

`db.chunks.where('docId').noneOf([...1,000 ids])` (and `anyOf`) is pathologically
slow under both Dexie and `fake-indexeddb` at this cardinality — hydrate did not
complete inside 180 s. `sweepOrphanChunks`/`listChunkIds` were rewritten to a
single full-table scan against a `Set` of live document ids, which is O(N) and
made hydrate complete in ~1.2 s. Operationally this is a one-pass read of the
encrypted rows per unlock; the rows are small and the working set stays bounded.
