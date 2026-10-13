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

Vacuum validates all six pairs among source data, source WAL, destination data
and destination WAL before committing the source or creating either output.
`RealFile` uses canonical paths and bigint device/inode identities, including
open source handles, to detect separate wrappers, hard links, symbolic links
and directory junctions. New destinations resolve through their existing parent
directory; dangling links resolve to their intended target. Existing independent
outputs may still be replaced. Preflight rejection leaves the source and outputs
untouched and keeps the database usable. The webclient does no destination cleanup
or replacement after such a rejection.

Custom `File` implementations used by vacuum must implement the optional
`getStorageIdentities()` method, returning every resource that creation, writes
or truncation can modify. Filesystem identities contain a canonical absolute
`path` and, for existing files, bigint `device` and `inode`. Memory files use
`{ kind: 'resource', resource: backingObject }`; wrappers share their backing
identity and compound files include their sidecars. `AtomicFile` forwards both
underlying files' identities. Missing identities are rejected before any writes;
other database operations do not require this method. Existing filesystem files
without a usable physical identity are also refused.

Validation assumes exclusive ownership of the paths during vacuum. It does not
prevent another process from changing links or replacing files between preflight
and creation. On Windows and macOS, case variants of a new output location are
conservatively rejected, including in case-sensitive directories.
New Windows stream paths, including `file::$DATA`, are refused because their
physical file identity cannot be established before creation.

Incremental candidate discovery retains one verified in-memory inventory per
backend session for records, B+ tree nodes and HNSW graph/vector/metadata units.
The first request inventories all eligible units; records are decoded and their
complete chains checked, preserving live-record integrity errors. Indexed max
heaps return the highest physical blocks without rewalking or resorting the
database for each small batch. Tombstoned HNSW units remain eligible physical
blockers. Deleted documents' retained record anchors remain allocated and are
reclaimed by full vacuum, as before.

Relocation updates only the moved chain or unit in these inventories, including
both graph and vector node identities when a graph node moves. Commit and free
tail trimming preserve them because eligible unit locations do not change.
Ordinary writes, index changes and failed mutations discard them; reopen starts
with no inventory. Candidate reads use the existing backend operation queue, so
a write cannot change locations halfway through an inventory. Returned targets
are copies. The old `CompactionState` cursor fields remain diagnostics; logical
ID order cannot express physical-tail continuation.

This amortizes candidate discovery across unchanged maintenance steps; the first
request after a mutation still requires a global inventory and session memory
proportional to eligible units. Free-list metrics and structure-specific
reference repair during relocation retain their existing traversal costs.
Incremental compaction can still stop at retained record anchors or other
ineligible physical blockers; full vacuum remains the complete rebuild path.

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
