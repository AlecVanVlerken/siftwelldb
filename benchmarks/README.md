# Benchmark suites

Run from the repository root on Node 24. Benchmarks are opt-in: `npm test`
excludes this folder, and no timing threshold is a unit-test assertion.
The regular test suite includes storage correctness, vacuum consistency/progress,
native HNSW contracts, and WAL recovery after subprocess termination.

## What remains relevant

| Suite                                    | Purpose                                                                                                                   | Entry point                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `compression/`                           | Current record format and all six codecs; identical seeded inputs; staged write, commit, decode and storage costs         | `npm run benchmark:compression -- --docs 1000 --size 4096 --seed 42`                  |
| `btree/`                                 | Persisted B+ tree insertion/search scaling                                                                                | `npm run benchmark:btree`                                                             |
| `dbms/`                                  | B+ tree versus B+ tree plus HNSW insert overhead with a deterministic mock encoder                                        | `npm run benchmark:dbms`                                                              |
| `dbms/embedding_speed.spec.mts`          | Optional model/dtype selection experiment; downloads Hugging Face models and can take an hour                             | `npm run benchmark:embeddings`                                                        |
| `hnsw/`                                  | Persisted native HNSW latency, recall and deletion scaling; DBMS overhead; historical TypeScript insertion comparison     | `npm run benchmark:hnsw`                                                              |
| `full-vacuum/`                           | Fragmentation, storage shrink, and query costs before/after full vacuum                                                   | `npm run benchmark:vacuum`                                                            |
| `incremental-compaction/`                | Convergence, relocation domains, observable consistency, reopen durability, maintenance, overhead and adversarial layouts | `npm run benchmark:incremental`                                                       |
| `large-dataset/`                         | Disk-backed loading and read workloads at database sizes larger than available RAM                                        | See [loader/workload instructions](large-dataset/README.txt)                          |
| `large-dataset/pagination-benchmark.mts` | Article lookup, word/content indexes, and cursor versus offset pagination on an existing article database                 | `npm run benchmark:pagination -- articles.db --runs 30 --page-size 20 --total 100000` |

The frozen `hnsw/legacyTs*` files are comparison baselines, not production code.
Their inclusion lets the insertion comparison measure the native backend against
the earlier algorithms using the same dataset and storage configuration.
`src/database/compression-profiles.mts` remains outside this folder because the
compression advisor uses its calibration profiles at runtime.

## Small local checks

The large benchmark defaults are intentionally expensive; do not run all suites
as a smoke test. These PowerShell commands need no downloaded vector dataset:

```powershell
npm.cmd run benchmark:compression -- --docs 8 --size 256

$env:BTREE_INSERT_COUNT = '1000'
$env:BTREE_CHECKPOINT_INTERVAL = '250'
$env:BTREE_SEARCH_QUERY_COUNT = '20'
npm run benchmark:btree

$env:DBMS_INSERT_COUNT = '100'
$env:DBMS_CHECKPOINT_INTERVAL = '25'
$env:DBMS_COMMIT_INTERVAL = '25'
npm run benchmark:dbms

npm run benchmark:incremental:k-convergence
```

For pagination, provide the exact article count with `--total` to avoid a full
counting scan. Omitting it counts the collection before measurements. Cursor
positioning happens outside the timed page fetch. Both pagination strategies now
use the denser sample points recovered from `feature/large-datasets`.

The PowerShell example uses `npm.cmd` so named script arguments pass through
Windows npm shims unchanged. On other platforms, use `npm`.

## Results and correctness

Generated `results/` directories, plots, Python bytecode, datasets, databases and
CPU profiles are ignored. Previous tracked result snapshots were removed because
they describe older revisions and are not evidence for current performance.
Plotting scripts recreate figures from fresh outputs; install their Python
dependencies separately. Record the revision, hardware, parameters and storage
backend when sharing results. MockFile measurements do not measure physical
disk latency or power-loss durability.

The full-vacuum consistency and progress cases moved to `src/compaction/` so
normal test runs exercise them. HNSW native contract tests recovered from
`s2-final-changes-thomas` live in `src/indexes/hnsw/tests/hnswNative.spec.mts`. The useful
`feature/simpledbms/Server1` failpoints became subprocess recovery tests under
`src/storage/wal/`: before WAL writing, after WAL sync, and during data writes. They
exercise the current AtomicFile implementation without modifying production
prototypes or reviving the obsolete server/CLI.

The historical full-compaction lockfile regeneration was discarded: it is
unrelated to benchmark coverage and removes dependency entries required by the
current package manifest. No historical server, soft-delete implementation,
generated native binary, or old dependency tree was merged.

See the [HNSW dataset instructions](hnsw/README.md) and
[incremental scenario documentation](incremental-compaction/README.txt) for
suite-specific configuration and plots.
