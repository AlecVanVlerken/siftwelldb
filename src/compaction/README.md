# Compaction

`compaction.mts` is the public entry point for full vacuum, incremental
compaction, explicit relocation, and free-tail reclamation. Its exports stay
stable while the implementations are grouped by responsibility:

- `vacuum/` rebuilds a database into fresh files: collection discovery, document
  copying, progress reporting, validation, and vacuum types.
- `incremental/` plans and runs bounded compaction steps in the existing database:
  storage metrics, policy, state, planner, service, and incremental types.
- `relocation/` moves record chains, B+ tree nodes, and HNSW units, and reclaims
  free blocks at the end of the database file.
- `tests/` contains integration and regression tests for consistency, durability,
  semantic equivalence, and interactions across storage structures.

Full vacuum preserves each field's stored compression codec, including
uncompressed fields and per-document overrides. Collection defaults are copied
for future writes; they do not recompress existing documents with a different
codec during vacuum. HNSW indexes are still rebuilt from live documents.

Unit tests live in `vacuum/tests/`, `incremental/tests/`, and `relocation/tests/`.
The public entry point is tested by `tests/compaction.spec.mts`. Performance benchmarks live separately under
`benchmarks/full-vacuum/` and `benchmarks/incremental-compaction/`.

Run the compaction tests from the repository root:

```sh
npx vitest run src/compaction
```
