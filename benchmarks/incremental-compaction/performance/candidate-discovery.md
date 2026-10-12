# Candidate discovery comparison

This benchmark compares `8bcd05c` with the cursor/compaction implementation using
real database and WAL files. It measures actual incremental compaction steps,
including relocation, commit and physical tail trimming. It does not time repeated
read-only candidate calls as a substitute for maintenance work.

Run both implementations serially with the same temporary seed directory:

```powershell
$env:COMPACTION_BENCH_DATA_DIR = '<temporary directory shared by both runs>'
$env:COMPACTION_BENCH_ROOT = '<checkout of 8bcd05c with node_modules available>'
$env:COMPACTION_BENCH_LABEL = 'before'
npx tsx benchmarks/incremental-compaction/performance/candidate-discovery-benchmark.mts

$env:COMPACTION_BENCH_ROOT = (git rev-parse --show-toplevel)
$env:COMPACTION_BENCH_LABEL = 'after'
npx tsx benchmarks/incremental-compaction/performance/candidate-discovery-benchmark.mts

python benchmarks/incremental-compaction/plotting/plot_candidate_discovery.py
```

A detached temporary `git worktree` is suitable for the baseline. It needs the
existing dependencies, but requires no additional Node packages. Remove the
temporary checkout and seed directory after comparing the runs. Without
`COMPACTION_BENCH_DATA_DIR`, a run creates and removes its own temporary directory.

The defaults are 1,000/5,000/10,000 inserted live documents, batch sizes 1/5/10/50,
three repetitions and three steps per repetition. Each repetition opens a fresh
byte-identical copy of the same seed files. Every measured step must relocate at
least one unit; the benchmark fails if it only reclaims a free suffix or makes no
progress. It also checks a relocated tail document and its binary field outside
the timing.

The dataset has primary, numeric and duplicate string secondary indexes, a low
address pool of freed filler records, mixed compression overrides and binary
fields. One fifth of live records span several blocks. `mixed-hnsw` adds a native
128-dimensional semantic index and deletes one twentieth of the initial live
records, retaining their HNSW nodes and vectors. Run that additional workload with:

```powershell
$env:COMPACTION_BENCH_WORKLOAD = 'mixed-hnsw'
$env:COMPACTION_BENCH_SIZES = '250,1000'
$env:COMPACTION_BENCH_BATCHES = '1,5,10'
```

Repeat both `before` and `after` invocations, then plot with
`--workload mixed-hnsw`. Sizes, batches, repetitions and step count can be changed
through `COMPACTION_BENCH_SIZES`, `COMPACTION_BENCH_BATCHES`,
`COMPACTION_BENCH_REPEATS` and `COMPACTION_BENCH_STEPS`.

`cold` means the first candidate inventory in each newly opened backend; it does
not mean a cold operating-system disk cache. `reused` covers the subsequent two
steps, after the first real relocations, commits and truncations. The summary
reports medians over three cold and six reused observations per configuration.
Discovery time is the wall-time interval spanning the three concurrent candidate
list calls. Relocation time covers the record/B+ tree/HNSW move calls. Total step
time includes storage metrics, allocation, reference repair, commits and tail
reclamation as well. Those phase medians do not necessarily add up.

The counters track documents decoded, explicit record-chain walks and chain
blocks, B+ tree nodes enumerated, HNSW graph/vector units enumerated and returned
candidates. `blockReads` counts `FreeBlockFile.readBlock()` calls during discovery;
`totalStepBlockReads` counts them throughout the step. These are API read calls,
including cache hits, rather than operating-system I/O counts. Chain blocks count
the explicit `readRecordBlockChain()` pass, not the separate document decode pass.

Raw CSV samples, summary CSVs and runtime metadata are written to
`../results/raw/candidate-discovery-<workload>-<before|after>*`. The plots are
`../results/plots/performance/candidate-discovery-<workload>.png`. Those generated
outputs follow the repository's existing ignored-results convention.

## Measured results

The committed summary below records a serial local run on 2026-10-12 with Node
24.9.0, an Intel i7-1255U and 16 GB RAM. Model downloads and external services were
not used. Timing differences between runs and machines remain possible.

Record/B+ tree reused-step medians, in milliseconds:

| Documents | Batch | Discovery before | Discovery after | Total step before | Total step after | Relocation before | Relocation after |
| --------- | ----- | ---------------- | --------------- | ----------------- | ---------------- | ----------------- | ---------------- |
| 1,000     | 1     | 279.659          | 0.099           | 400.890           | 107.853          | 14.096            | 14.860           |
| 1,000     | 5     | 354.292          | 0.137           | 548.513           | 142.664          | 23.029            | 25.659           |
| 1,000     | 10    | 327.929          | 0.154           | 542.261           | 133.073          | 31.099            | 21.283           |
| 1,000     | 50    | 295.241          | 0.311           | 436.851           | 134.843          | 43.475            | 53.850           |
| 5,000     | 1     | 1,409.197        | 0.056           | 1,966.424         | 501.291          | 80.652            | 73.383           |
| 5,000     | 5     | 1,443.741        | 0.104           | 2,245.027         | 724.284          | 95.176            | 96.882           |
| 5,000     | 10    | 1,200.456        | 0.136           | 1,914.576         | 698.622          | 80.738            | 96.407           |
| 5,000     | 50    | 1,327.173        | 0.294           | 2,064.423         | 764.231          | 132.103           | 142.420          |
| 10,000    | 1     | 2,723.325        | 0.057           | 3,798.770         | 922.751          | 175.541           | 160.571          |
| 10,000    | 5     | 2,563.902        | 0.104           | 4,064.775         | 1,248.840        | 182.020           | 172.648          |
| 10,000    | 10    | 2,857.395        | 0.146           | 4,279.940         | 1,375.530        | 183.727           | 162.662          |
| 10,000    | 50    | 2,555.127        | 0.370           | 3,979.657         | 1,366.859        | 223.369           | 247.380          |

The first inventory remains expensive. Batch-one cold medians:

| Documents | Discovery before (ms) | Discovery after (ms) | Total step before (ms) | Total step after (ms) |
| --------- | --------------------- | -------------------- | ---------------------- | --------------------- |
| 1,000     | 324.470               | 326.805              | 511.541                | 475.520               |
| 5,000     | 1,396.848             | 1,419.943            | 2,196.775              | 2,170.912             |
| 10,000    | 2,417.039             | 2,564.280            | 4,022.193              | 4,164.057             |

Both implementations' cold inventories decode and walk all live records and
enumerate all B+ tree nodes. Before the change, the same work repeats on every
step; after it, each reused discovery does zero document decodes, zero explicit
chain walks, zero B+ tree node enumeration and zero block-read calls. This holds
for all four measured batch sizes. The nonzero work counts per initial inventory
and per reused baseline inventory are:

| Documents | Decodes | Chain walks | Chain blocks | B+ tree nodes | Reused baseline block-read calls |
| --------- | ------- | ----------- | ------------ | ------------- | -------------------------------- |
| 1,000     | 1,000   | 1,000       | 1,600        | 30            | 3,200                            |
| 5,000     | 5,000   | 5,000       | 8,000        | 145           | 16,000                           |
| 10,000    | 10,000  | 10,000      | 16,000       | 290           | 32,000                           |

Mixed HNSW reused-step medians:

| Initially inserted documents | Batch | Discovery before (ms) | Discovery after (ms) | Total step before (ms) | Total step after (ms) |
| ---------------------------- | ----- | --------------------- | -------------------- | ---------------------- | --------------------- |
| 250                          | 1     | 67.636                | 0.122                | 105.301                | 35.999                |
| 250                          | 5     | 66.249                | 0.163                | 107.700                | 42.042                |
| 250                          | 10    | 63.461                | 0.176                | 116.595                | 43.932                |
| 1,000                        | 1     | 321.177               | 0.065                | 460.718                | 122.726               |
| 1,000                        | 5     | 274.947               | 0.131                | 418.516                | 121.413               |
| 1,000                        | 10    | 269.319               | 0.243                | 464.079                | 235.372               |

After the deletions, these datasets have 238 and 950 live documents. Every
reused baseline step still decodes/walks those records and enumerates 230 and 570
HNSW graph/vector units respectively; reused discovery after the change does
none of that work. HNSW unit counts follow the existing collection-local
reachable-graph traversal shared by both implementations; the benchmark does not
assume they equal twice the number of documents. Tombstoned retained units remain
eligible. The CSV samples also record actual moved units and reclaimed tail blocks.

## Interpretation

The first inventory still validates and decodes every live document, walks its
record chain, and enumerates the B+ tree and HNSW units. This preserves record
integrity errors and establishes globally correct physical-tail priority.

Subsequent candidate discovery reuses a session-local priority catalog. Successful
relocations refresh moved addresses; commit and truncation preserve the remaining
valid inventory. Ordinary document/index mutations invalidate it, and reopening
starts a fresh inventory. A write before every batch can therefore still require
an inventory before every batch. The catalog uses memory proportional to the
number of candidate units.

Global free-list statistics, allocation scans and some relocation reference
repairs remain in the total step cost. The planner also avoids a redundant metrics
collection and asks each candidate type for the actual batch size. These changes
are included in the before/after total-step comparison. The measurements do not
claim constant-time compaction or constant-time first discovery.

A related correction reports a successful record relocation when its original
head is already below the target boundary but its chain tail is above it. The
timed dataset begins with high original heads and moves them into low holes, so
that result-flag correction does not change these measurements.
