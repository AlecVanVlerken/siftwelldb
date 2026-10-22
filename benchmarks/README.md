# Benchmark suites

Run benchmarks from the repository root on Node 24. They are separate from `npm test` because they measure performance
across larger workloads. Correctness and recovery tests run as part of the regular test suite.

## Suites

| Suite                                    | Purpose                                                                                                                   | Entry point                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `compression/`                           | Current record format and all six codecs; identical seeded inputs; staged write, commit, decode and storage costs         | `npm run benchmark:compression -- --docs 1000 --size 4096 --seed 42`                  |
| `btree/`                                 | Persisted B+ tree insertion/search scaling                                                                                | `npm run benchmark:btree`                                                             |
| `query/`                                 | Query plans, document reads and execution time across collection sizes                                                    | `npm run benchmark:query`                                                             |
| `dbms/`                                  | B+ tree versus B+ tree plus HNSW insert overhead with a deterministic mock encoder                                        | `npm run benchmark:dbms`                                                              |
| `dbms/embedding_speed.spec.mts`          | Optional model/dtype selection experiment; downloads Hugging Face models and can take an hour                             | `npm run benchmark:embeddings`                                                        |
| `hnsw/`                                  | Persisted native HNSW latency, recall and deletion scaling; DBMS overhead; historical TypeScript insertion comparison     | `npm run benchmark:hnsw`                                                              |
| `full-vacuum/`                           | Fragmentation, storage shrink and query costs before/after full vacuum                                                    | `npm run benchmark:vacuum`                                                            |
| `incremental-compaction/`                | Convergence, relocation domains, observable consistency, reopen durability, maintenance, overhead and adversarial layouts | `npm run benchmark:incremental`                                                       |
| `large-dataset/`                         | Disk-backed loading and read workloads at database sizes larger than available RAM                                        | See [loader/workload instructions](large-dataset/README.txt)                          |
| `large-dataset/pagination-benchmark.mts` | Article lookup, word/content indexes and cursor versus offset pagination on an existing article database                  | `npm run benchmark:pagination -- articles.db --runs 30 --page-size 20 --total 100000` |

The `hnsw/legacyTs*` files provide the earlier TypeScript implementation for the insertion comparison. Both backends use
the same dataset and storage settings. Compression calibration profiles live in `src/database/compression-profiles.mts`
because the compression advisor also uses them at runtime.

## Small local checks

Several suites default to large datasets. These smaller PowerShell runs are useful for checking the harness without
downloading vector datasets:

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

For pagination, provide the exact article count with `--total` to avoid a full counting scan. Omitting it counts the
collection before measurements. Cursor positioning happens outside the timed page fetch.

The PowerShell example uses `npm.cmd` so named script arguments pass through Windows npm shims unchanged. On other
platforms, use `npm`.

## Results and correctness

Generated `results/` directories, plots, Python bytecode, datasets, databases and CPU profiles are ignored. Plotting
scripts generate figures from the recorded outputs; install their Python dependencies separately. Record the revision,
hardware, parameters and storage backend when sharing results. MockFile measurements do not measure physical disk
latency or power-loss durability.

Full-vacuum consistency and progress tests live in `src/compaction/`. Native bridge tests live in
`src/indexes/hnsw/tests/hnswNative.spec.mts`. WAL tests under `src/storage/wal/` terminate subprocesses before log
writing, after log sync and during data writes, then reopen the files to check recovery.

[Webclient deletion and vacuum measurements](../docs/webclient-performance.md) compare operation times and record reads
for those service-level workloads.

See the [HNSW dataset instructions](hnsw/README.md) and
[incremental scenario documentation](incremental-compaction/README.txt) for suite-specific configuration and plots.
