# HNSW Benchmarking

This folder contains the long-running HNSW benchmarks that exercise the wrapper implementation in [src/hnsw/hnswIndex.mts](../../hnsw/hnswIndex.mts), not only the native Rust core.

## What is measured

- `complexity.spec.mts` builds an `HNSWIndex` on SIFT1M and records checkpointed insert and search latency against database size.
- `simpledbms_complexity.spec.mts` runs the same SIFT1M complexity experiment through `SimpleDbms`, so record-store, B+ tree, and HNSW overhead are all included.
- `recall.spec.mts` measures recall on SIFT1M, GIST1M, and 1M random 128D vectors.

Commits still happen so the persisted index stays valid, but commit time is not included in the reported insert timings.

- `plot_complexity.py` turns the SIFT complexity JSON into the four requested graphs.
- `plot_recall.py` overlays the recall curves so structured and unstructured datasets can be compared directly.

## Dataset layout

Expected folders:

- `src/benchmarking/hnsw/datasets/sift/`
- `src/benchmarking/hnsw/datasets/gist/`

Expected files:

- `sift_base.fvecs`
- `sift_query.fvecs`
- `sift_groundtruth.ivecs`
- `gist_base.fvecs`
- `gist_query.fvecs`
- `gist_groundtruth.ivecs`

The benchmark code uses Texmex `.fvecs` and `.ivecs` files directly.

## Run the benchmarks

Complexity benchmark:

```powershell
NODE_OPTIONS="--max-old-space-size=8192" npx vitest run src/benchmarking/hnsw/complexity.spec.mts --reporter=verbose
```

SimpleDbms complexity benchmark:

```powershell
NODE_OPTIONS="--max-old-space-size=8192" npx vitest run src/benchmarking/hnsw/simpledbms_complexity.spec.mts --reporter=verbose
```

Recall benchmarks:

```powershell
NODE_OPTIONS="--max-old-space-size=8192" npx vitest run src/benchmarking/hnsw/recall.spec.mts --reporter=verbose
```

Run a single recall experiment:

```powershell
NODE_OPTIONS="--max-old-space-size=8192" npx vitest run src/benchmarking/hnsw/recall.spec.mts --reporter=verbose --testNamePattern="SIFT1M"
NODE_OPTIONS="--max-old-space-size=8192" npx vitest run src/benchmarking/hnsw/recall.spec.mts --reporter=verbose --testNamePattern="GIST1M"
NODE_OPTIONS="--max-old-space-size=8192" npx vitest run src/benchmarking/hnsw/recall.spec.mts --reporter=verbose --testNamePattern="random 1M 128D"
```

The benchmark prints elapsed time and ETA while it is running.

## Plot the graphs

```powershell
python src/benchmarking/hnsw/plot_complexity.py
python src/benchmarking/hnsw/plot_recall.py
```

To plot the SimpleDbms complexity result, point the complexity plotter at the alternate JSON file:

```powershell
$env:HNSW_COMPLEXITY_INPUT="src/benchmarking/hnsw/results/complexity_simpledbms_sift1m.json"
python src/benchmarking/hnsw/plot_complexity.py
```

Generated images are written to `src/benchmarking/hnsw/results/images/`.

## Useful environment variables

- `HNSW_BENCH_STORAGE=real|mock` selects the persistence backend. Default is `real`.
- `HNSW_KEEP_DB=true` keeps the generated database files under `results/db/` after the run.
- `HNSW_SIFT_LIMIT`, `HNSW_GIST_LIMIT`, `HNSW_RANDOM_COUNT` cap the build size for smaller dry runs.
- `HNSW_RECALL_QUERY_LIMIT` caps SIFT and GIST query count for faster sweeps.
- `HNSW_RECALL_EF_SEARCH_VALUES=8,16,32,64,128,200` overrides the sweep values.
- `HNSW_COMMIT_INTERVAL`, `HNSW_M`, `HNSW_EF_CONSTRUCTION`, and `HNSW_EF_SEARCH` tune the index configuration. `HNSW_COMMIT_INTERVAL` still affects when persistence happens, but not the reported insert timing.

## Note on efSearch sweeps

`efSearch` is part of the public `HNSWIndex` configuration, so each recall sweep point reopens the persisted `HNSWIndex` with a different `efSearch` value and then runs queries through `HNSWIndex.search(...)`. This keeps the sweep on the wrapper API instead of touching private native state.
