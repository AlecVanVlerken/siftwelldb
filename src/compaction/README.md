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

Unreadable live records abort copying or validation. Both stages check their
document counts against independent primary-index reference counts. A failed
copy closes its incomplete target and leaves the source database in place.

The webclient service replaces closed data/WAL pairs using a synchronized
`.vacuum-state.json` manifest and per-operation temporary/backup files. Sizes and
SHA-256 fingerprints identify both complete generations. Startup restores the
original pair while the manifest is `prepared`; after the replacement has reopened
and the `verified` decision is published, it keeps the replacement. Recovery
verifies the selected pair before removing backups and removes the manifest last.
Interrupted recovery or cleanup can be retried.

Unknown generations, missing required files, invalid manifests, and orphan vacuum
artifacts cause explicit errors and retain recovery evidence. Connect and
force-create refuse these artifacts; a missing data file with an existing WAL
also refuses automatic database creation. Recovery assumes exclusive ownership
of the database files, as ordinary database access does.

Real-process termination tests cover the replacement and rollback checkpoints.
Files are synchronized before publication; directories are synchronized where
supported. Node cannot synchronize directories on Windows, so directory-entry
durability across power loss is not guaranteed there. The restart protocol does
not repair damaged media or make multiple renames power-loss atomic.

Unit tests live in `vacuum/tests/`, `incremental/tests/`, and `relocation/tests/`.
The public entry point is tested by `tests/compaction.spec.mts`. Performance benchmarks live separately under
`benchmarks/full-vacuum/` and `benchmarks/incremental-compaction/`.

Run the compaction tests from the repository root:

```sh
npx vitest run src/compaction
```
