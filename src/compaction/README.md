# Compaction

Compaction deals with free space left behind by deletions and updates. Full vacuum copies live documents into new files.
Incremental compaction moves storage units within the open database and reclaims free blocks at the end of the file.
`compaction.mts` exports both approaches and the lower-level relocation functions.

## Modules

- `vacuum/` rebuilds a database into fresh files: collection discovery, document copying, progress reporting, validation
  and vacuum types.
- `incremental/` plans and runs bounded compaction steps in the existing database: storage metrics, policy, state,
  planner, service and incremental types.
- `relocation/` moves record chains, B+ tree nodes and HNSW units and reclaims free blocks at the end of the database
  file.
- `tests/` contains integration and regression tests for consistency, durability, semantic equivalence and interactions
  across storage structures.

## Full vacuum

Full vacuum preserves each field's stored compression codec, including uncompressed fields and per-document overrides.
Collection defaults are copied for future writes; they do not recompress existing documents with a different codec
during vacuum. HNSW indexes are rebuilt from live documents, which removes tombstones and their retained storage.

### Destination validation

Vacuum validates all six pairs among source data, source WAL, destination data and destination WAL before committing the
source or creating either output. `RealFile` uses canonical paths and bigint device/inode identities, including open
source handles, to detect separate wrappers, hard links, symbolic links and directory junctions. New destinations
resolve through their existing parent directory; dangling links resolve to their intended target. Existing independent
outputs may still be replaced. Preflight rejection leaves the source and outputs untouched and keeps the database
usable.

Custom `File` implementations used by vacuum must implement the optional `getStorageIdentities()` method, returning
every resource that creation, writes or truncation can modify. Filesystem identities contain a canonical absolute `path`
and, for existing files, bigint `device` and `inode`. Memory files use `{ kind: 'resource', resource: backingObject }`;
wrappers share their backing identity and compound files include their sidecars. `AtomicFile` forwards both underlying
files' identities. Missing identities are rejected before any writes; other database operations do not require this
method. Existing filesystem files without a usable physical identity are also refused.

Validation assumes exclusive ownership of the paths during vacuum. It does not prevent another process from changing
links or replacing files between preflight and creation. On Windows and macOS, case variants of a new output location
are conservatively rejected, including in case-sensitive directories. New Windows stream paths, including `file::$DATA`,
are refused because their physical file identity cannot be established before creation.

## Incremental compaction

Incremental compaction starts by building an in-memory inventory of records, B+ tree nodes and HNSW graph, vector and
metadata units. It decodes records and checks their chains while building that inventory. Indexed max heaps then return
the highest allocated blocks, avoiding a full scan for every small batch. Tombstoned HNSW units can move too, but their
record anchors remain allocated until full vacuum.

Relocation updates only the moved chain or unit in these inventories, including both graph and vector node identities
when a graph node moves. Commit and free tail trimming preserve them because eligible unit locations do not change.
Ordinary writes, index changes and failed mutations discard them; reopen starts with no inventory. Candidate reads use
the existing backend operation queue, so a write cannot change locations halfway through an inventory. Returned targets
are copies. `CompactionState` cursor fields are diagnostic: logical ID order does not describe which physical blocks are
nearest the end of the file.

The inventory spreads candidate-discovery work across maintenance steps. The first step after a mutation requires
another full inventory and memory proportional to the number of eligible units. Computing free-list metrics and
repairing references have separate traversal costs. Retained allocations can prevent tail truncation even after movable
units have been relocated. Full vacuum rebuilds the file when those allocations need to be removed.

## Validation and file replacement

Unreadable live records abort copying or validation. Both stages check their document counts against independent
primary-index reference counts. A failed copy closes its incomplete target and leaves the source database in place.

The webclient service replaces closed data/WAL pairs using a synchronized `.vacuum-state.json` manifest and
per-operation temporary/backup files. Sizes and SHA-256 fingerprints identify both complete generations. Startup
restores the original pair while the manifest is `prepared`; after the replacement has reopened and the `verified`
decision is published, it keeps the replacement. Recovery verifies the selected pair before removing backups and removes
the manifest last. Interrupted recovery or cleanup can be retried.

Unknown generations, missing required files, invalid manifests and orphan vacuum artifacts cause explicit errors and
retain recovery evidence. Connect and force-create refuse these artifacts; a missing data file with an existing WAL also
refuses automatic database creation. Recovery assumes exclusive ownership of the database files, as ordinary database
access does.

Real-process termination tests cover the replacement and rollback checkpoints. Files are synchronized before
publication; directories are synchronized where supported. Node cannot synchronize directories on Windows, so
directory-entry durability across power loss is not guaranteed there. The restart protocol does not repair damaged media
or make multiple renames power-loss atomic.

## Tests and benchmarks

Unit tests live in `vacuum/tests/`, `incremental/tests/` and `relocation/tests/`. The public entry point is tested by
`tests/compaction.spec.mts`. Performance benchmarks live separately under `benchmarks/full-vacuum/` and
`benchmarks/incremental-compaction/`.

Run the compaction tests from the repository root:

```sh
npx vitest run src/compaction
```
