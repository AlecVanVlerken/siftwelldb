# HNSW Benchmarking

These benchmarks exercise [HNSWIndex](../../src/indexes/hnsw/hnswIndex.mts), including its TypeScript persistence
wrapper and native Rust implementation.

## What is measured

- `complexity.spec.mts` builds an `HNSWIndex` on SIFT1M and records checkpointed insert and search latency against
  database size.
- `delete_complexity.spec.mts` builds an `HNSWIndex` on a capped SIFT subset, then deletes every vector in reverse order
  and records checkpointed delete latency against the remaining live index size.
- `simpledbms_complexity.spec.mts` runs the same SIFT1M complexity experiment through `SimpleDbms`, including
  record-store, B+ tree and HNSW overhead.
- `recall.spec.mts` measures recall on SIFT1M, GIST1M and 1M random 128D vectors.
- `insert_compare.spec.mts` compares the Rust-backed `HNSWIndex` with the earlier TypeScript implementation on the first
  1M SIFT vectors by default. Both runs use the same dataset, storage and HNSW parameters. It records insert timings
  during the main loop and commits outside the timed section.

Commit time is excluded from the reported insert timings.

- `plot_complexity.py` plots the SIFT complexity results.
- `plot_delete_complexity.py` turns the deletion benchmark JSON into delete-over-time and delete-vs-live-size graphs.
- `plot_recall.py` overlays the recall curves so structured and unstructured datasets can be compared directly.

## Dataset setup

There is no separate dataset import step for these benchmarks. The benchmark code reads Texmex `.fvecs` and `.ivecs`
files directly from disk via `benchmarks/hnsw/texmex.mts`, and each benchmark run rebuilds its own HNSW index from the
`*_base.fvecs` files.

Setup steps:

1. Download and extract the SIFT1M and/or GIST1M datasets in Texmex format.
2. Place the extracted files under these folders:
   - `benchmarks/hnsw/datasets/sift/`
   - `benchmarks/hnsw/datasets/gist/`

3. Keep the default filenames below, or override them with environment variables.

Expected folders:

- `benchmarks/hnsw/datasets/sift/`
- `benchmarks/hnsw/datasets/gist/`

Expected files:

- `sift_base.fvecs`
- `sift_query.fvecs`
- `sift_groundtruth.ivecs`
- `gist_base.fvecs`
- `gist_query.fvecs`
- `gist_groundtruth.ivecs`

Optional files such as `sift_learn.fvecs` and `gist_learn.fvecs` may live next to the required files after extraction,
but the current benchmarks do not read them.

If you keep the datasets outside the repo, point the benchmarks at them with `HNSW_SIFT_DIR` and `HNSW_GIST_DIR`. You
can also override individual filenames with `HNSW_SIFT_BASE_FILE`, `HNSW_SIFT_QUERY_FILE`, `HNSW_SIFT_GT_FILE`,
`HNSW_GIST_BASE_FILE`, `HNSW_GIST_QUERY_FILE` and `HNSW_GIST_GT_FILE`.

## Run the benchmarks

For these PowerShell examples, first increase the Node.js heap limit:

```powershell
$env:NODE_OPTIONS = '--max-old-space-size=8192'
```

Complexity benchmark:

```powershell
npx vitest run benchmarks/hnsw/complexity.spec.mts --reporter=verbose
```

SimpleDbms complexity benchmark:

```powershell
npx vitest run benchmarks/hnsw/simpledbms_complexity.spec.mts --reporter=verbose
```

Deletion complexity benchmark:

```powershell
npx vitest run benchmarks/hnsw/delete_complexity.spec.mts --reporter=verbose
```

The deletion benchmark reports both pure tombstone marking time and durable delete time with commit work amortized over
each checkpoint window. The `deleteMeanMs` JSON field and the main plot use durable delete time; `pureDeleteMeanMs`
keeps the raw HNSW tombstone primitive visible separately.

Recall benchmarks:

```powershell
npx vitest run benchmarks/hnsw/recall.spec.mts --reporter=verbose
```

Rust vs legacy TypeScript insert comparison on the first 1M SIFT vectors by default:

```powershell
npx vitest run benchmarks/hnsw/insert_compare.spec.mts --reporter=verbose
```

Run a single recall experiment:

```powershell
npx vitest run benchmarks/hnsw/recall.spec.mts --reporter=verbose --testNamePattern="SIFT1M"
npx vitest run benchmarks/hnsw/recall.spec.mts --reporter=verbose --testNamePattern="GIST1M"
npx vitest run benchmarks/hnsw/recall.spec.mts --reporter=verbose --testNamePattern="random 1M 128D"
```

The benchmark prints elapsed time and ETA while it is running.

The insertion comparison reports elapsed time and estimated time remaining for each backend separately.

## Plot the graphs

```powershell
python benchmarks/hnsw/plot_complexity.py
python benchmarks/hnsw/plot_delete_complexity.py
python benchmarks/hnsw/plot_recall.py
python benchmarks/hnsw/plot_insert_compare.py
```

To plot the SimpleDbms complexity result, point the complexity plotter at the alternate JSON file:

```powershell
$env:HNSW_COMPLEXITY_INPUT="benchmarks/hnsw/results/complexity_simpledbms_sift1m.json"
python benchmarks/hnsw/plot_complexity.py
```

Generated images are written to `benchmarks/hnsw/results/images/`.

## Useful environment variables

- `HNSW_BENCH_STORAGE=real|mock` selects the persistence backend. Default is `real`.
- `HNSW_KEEP_DB=true` keeps the generated database files under `results/db/` after the run.
- `HNSW_SIFT_DIR`, `HNSW_GIST_DIR` and the `HNSW_*_{BASE,QUERY,GT}_FILE` overrides let you load datasets from another
  folder or with different filenames.
- `HNSW_SIFT_LIMIT`, `HNSW_GIST_LIMIT`, `HNSW_RANDOM_COUNT` cap the build size for smaller dry runs.
- `HNSW_DELETE_LIMIT` caps the initial SIFT build size for the deletion benchmark. Default is `100000`.
- `HNSW_DELETE_CHECKPOINT_INTERVAL` controls how often the deletion benchmark records a point. Default is `100`.
- `HNSW_DELETE_COMMIT_INTERVAL` controls how often the deletion benchmark commits while shrinking the index. Default is
  `10`.
- `HNSW_COMPARE_INSERT_LIMIT` caps the Rust-vs-TypeScript insert comparison size. Default is `1000000`.
- `HNSW_COMPARE_CHECKPOINT_INTERVAL` controls how often the insert comparison records a point and refreshes ETA output.
  Default is `1000`.
- `HNSW_RECALL_QUERY_LIMIT` caps SIFT and GIST query count for faster sweeps.
- `HNSW_RECALL_EF_SEARCH_VALUES=8,16,32,64,128,200` overrides the sweep values.
- `HNSW_COMMIT_INTERVAL`, `HNSW_M`, `HNSW_EF_CONSTRUCTION` and `HNSW_EF_SEARCH` tune the index configuration.
  `HNSW_COMMIT_INTERVAL` controls persistence frequency, with commit time excluded from the reported insert timing.

## Note on efSearch sweeps

`efSearch` is part of the public `HNSWIndex` configuration, so each recall sweep point reopens the persisted `HNSWIndex`
with a different `efSearch` value and then runs queries through `HNSWIndex.search(...)`. This keeps the sweep on the
wrapper API instead of touching private native state.
