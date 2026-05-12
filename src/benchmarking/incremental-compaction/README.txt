Incremental Compaction Benchmarks
================================

This directory contains the benchmark and demonstration suite for K-metric
incremental compaction. The suite is grouped by the question each benchmark
answers, so the folder is no longer one flat list of unrelated scripts.

Folder structure
----------------

- core/
  Shrink and convergence benchmarks:
  k-convergence, heavy-delete, mixed-churn, mixed-tail-blockers.

- relocation/
  Relocation-domain benchmarks:
  RecordStore, B+ tree, HNSW, controlled mixed tail blockers, and targeted
  blocker-clear sequences.

- consistency/
  Observable correctness benchmarks:
  record-to-B+ tree reference stability, record-to-HNSW reference stability,
  and exact HNSW semantic equivalence.

- durability/
  Commit/reopen durability demonstrations.

- maintenance/
  Long-running and idle-style maintenance:
  no-op/plateau, bounded idle steps, long-run idle maintenance,
  maintenance stability, rolling churn, and fallback honesty.

- performance/
  Runtime overhead and cost-vs-benefit benchmarks.

- adversarial/
  Pathological layouts and stress scenarios.

- shared/
  Shared benchmark utilities, consistency snapshot helpers, and targeted
  storage helpers.

- plotting/
  Python plot generator for grouped benchmark figures.

Results
-------

Raw benchmark outputs are written to:

  src/benchmarking/incremental-compaction/results/raw/

This includes:

- one JSON summary per scenario
- one per-step CSV per scenario
- incremental_compaction_summary.csv
- timeline CSVs for long-run scenarios

Plots are written to:

  src/benchmarking/incremental-compaction/results/plots/

The plot folders are grouped by purpose:

- plots/core/
- plots/relocation/
- plots/consistency/
- plots/durability/
- plots/maintenance/
- plots/performance/
- plots/adversarial/

The plotter also writes:

  results/plots/plot_manifest.json

which records which scenarios fed each plot group.

Commands
--------

Run all incremental benchmarks:

  npm run benchmark:incremental

Run one category:

  npm run benchmark:incremental:core
  npm run benchmark:incremental:relocation
  npm run benchmark:incremental:consistency
  npm run benchmark:incremental:durability
  npm run benchmark:incremental:maintenance
  npm run benchmark:incremental:performance
  npm run benchmark:incremental:adversarial

Run one benchmark:

  npm run benchmark:incremental:k-convergence
  npm run benchmark:incremental:heavy-delete
  npm run benchmark:incremental:mixed-churn
  npm run benchmark:incremental:mixed-tail
  npm run benchmark:incremental:recordstore
  npm run benchmark:incremental:btree
  npm run benchmark:incremental:btree-dominant
  npm run benchmark:incremental:btree-sequence
  npm run benchmark:incremental:hnsw
  npm run benchmark:incremental:hnsw-dominant
  npm run benchmark:incremental:hnsw-sequence
  npm run benchmark:incremental:ordered-mixed
  npm run benchmark:incremental:mixed-minimized
  npm run benchmark:incremental:record-btree-reference
  npm run benchmark:incremental:record-hnsw-reference
  npm run benchmark:incremental:hnsw-semantic-equivalence
  npm run benchmark:incremental:mixed-durability
  npm run benchmark:incremental:long-run-idle
  npm run benchmark:incremental:maintenance-stability
  npm run benchmark:incremental:rolling-churn
  npm run benchmark:incremental:plateau-fallback
  npm run benchmark:incremental:noop-plateau
  npm run benchmark:incremental:bounded-idle
  npm run benchmark:incremental:performance-single
  npm run benchmark:incremental:overhead
  npm run benchmark:incremental:adversarial-single

Generate all grouped plots:

  npm run benchmark:incremental:plot

Plot families
-------------

- core/core_shrink_comparison.png
  Compares the main shrink/convergence scenarios by total blocks.

- core/core_amplification_comparison.png
  Shows whether core scenarios move storage amplification toward K.

- relocation/relocation_type_comparison.png
  Shows RecordStore, B+ tree, HNSW, and tail-reclaim work by relocation
  scenario.

- relocation/relocation_step_attribution.png
  Shows which relocation kinds happened per step for targeted blocker
  scenarios.

- consistency/consistency_summary.png
  Shows pass/fail style correctness checks for reference-stability and HNSW
  equivalence benchmarks.

- durability/durability_reopen_amplification.png
  Shows compact/reopen durability scenarios without mixing them into the core
  shrink plots.

- maintenance/maintenance_amplification_summary.png
  Summarizes no-op, plateau, idle, and long-run maintenance amplification.

- maintenance/maintenance_timeline.png
  Shows amplification over repeated workload/maintenance phases.

- performance/performance_overhead.png
  Plots maintenance time against reclaimed bytes for overhead scenarios.

- adversarial/adversarial_amplification.png
  Keeps stress/pathological layouts separate from normal core behavior.

Interpretation notes
--------------------

- Core plots answer whether incremental compaction shrinks and converges.
- Relocation plots answer which storage kind did the work.
- Consistency plots answer whether records, indexes, cursors, and semantic
  results stayed equivalent.
- Maintenance plots answer whether bounded idle compaction behaves sensibly
  over time and reports plateau/fallback honestly.
- Performance plots answer whether compaction cost is proportional to useful
  work.

HNSW note
---------

HNSW semantic equivalence has two different implementation stories:

- Incremental record relocation preserves HNSW structure by stable relabeling.
  It updates the persisted document pointer/payload identity for the existing
  HNSW node and does not delete/reinsert the entry.

- Full vacuum does not promise raw HNSW graph preservation. It rebuilds HNSW
  through deterministic logical reinsertion into fresh files.

The relabel invariant spec compares the HNSW graph snapshot before/after
relabeling, normalizing only the intended document pointer change. The compared
snapshot includes entry point, current max level, node IDs, vector pointers,
vector payload values, deleted flags, levels, and neighbor lists.

Correctness specs outside this folder
-------------------------------------

- src/compaction/incremental-consistency.spec.mts
- src/compaction/incremental-durability.spec.mts
- src/compaction/record-btree-consistency-after-compaction.spec.mts
- src/compaction/record-hnsw-consistency-after-compaction.spec.mts
- src/compaction/incremental-hnsw-semantic-equivalence.spec.mts
- src/compaction/vacuum-hnsw-semantic-equivalence.spec.mts
- src/compaction/hnsw-relabel-graph-invariant.spec.mts
- src/compaction/cross-collection-isolation-after-compaction.spec.mts
- src/compaction/repeated-relocation-invariants.spec.mts
- src/compaction/mixed-cross-structure-consistency.spec.mts
- src/compaction/mixed-hnsw-cross-structure-semantic-equivalence.spec.mts
- src/compaction/relocation-durability-cross-structure.spec.mts
