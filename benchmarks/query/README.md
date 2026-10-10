# Query performance

Run `npm run benchmark:query`. Optional environment variables:

- `QUERY_BENCH_SIZES=1000,2000,5000,10000`
- `QUERY_BENCH_TAG=after` (output prefix)
- `QUERY_BENCH_OPERATIONS=id,conjunction,indexed,unindexed,range,primary-range,string-range,limit,sort,aggregate,update`

Results include raw sample CSVs, summary CSVs and JSON with runtime/machine
metadata in `results/`. Generated results are ignored by Git.

The harness uses the existing 4096-byte MockFile storage and native HNSW,
with a deterministic 4D encoder. It does not download models. Each collection
contains string IDs, indexed year/category/title and unindexed body text.
Every operation has five warmups and 40 measured repetitions. Setup and commit
are excluded; the webclient's displayed duration separately includes commit.
The read counter counts RecordStore document decodes, not physical disk reads.
Each measured result is checked outside the timer against expected values;
sort and LIMIT order, aggregate counts and the final UPDATE payload are checked.

The baseline was the branch's unchanged `29a34dc`; the second range baseline
used an isolated checkout of that same commit and the same harness. Result
row counts were identical before/after. These are local mock-storage timings,
not production latency guarantees or evidence of an asymptotic complexity bound.
Some runs overlapped validation commands; timing, JIT and GC variability are
visible in the raw files. Read/embedding counts are the stronger evidence.

## Measured comparison, 2026-10-10

Node v24.9.0, Intel Core i7-1255U. Values are p50 / p95 milliseconds.

| Documents | Exact first ID before → after     | LIMIT 10 before → after           | Two-field UPDATE before → after   |
| --------- | --------------------------------- | --------------------------------- | --------------------------------- |
| 1,000     | 12.989 / 15.345 → 0.097 / 0.491   | 40.263 / 52.224 → 0.586 / 0.704   | 43.784 / 46.044 → 1.214 / 1.585   |
| 2,000     | 84.742 / 92.189 → 0.116 / 0.258   | 80.967 / 86.255 → 0.550 / 0.804   | 84.815 / 87.804 → 1.087 / 1.458   |
| 5,000     | 207.709 / 227.188 → 0.109 / 0.188 | 201.272 / 243.615 → 0.456 / 0.504 | 208.799 / 249.140 → 1.093 / 1.909 |
| 10,000    | 411.970 / 444.858 → 0.108 / 0.204 | 409.640 / 446.818 → 0.445 / 0.569 | 444.008 / 490.003 → 1.455 / 2.542 |

Exact-ID reads dropped from N to 1; the unindexed body predicate followed by
`AND id = ...` also reads 1 rather than N. LIMIT 10 reads 10 instead of N.
The original UPDATE measurement read 2 instead of N + 5 and generated one
embedding instead of two. The regression audit below adds one typed-document
read to preserve arbitrary binary fields, bringing current UPDATE reads to 3.
Reading encoded compression metadata is not counted as a document decode.

The separate range run measured primary-ID bounds matching ten rows and a
string category range matching 20% of the collection. Values below are medians.

| Documents | Primary range before → after (ms) | String range before → after (ms) | Primary reads before → after | String reads before → after |
| --------- | --------------------------------- | -------------------------------- | ---------------------------- | --------------------------- |
| 1,000     | 41.943 → 0.160                    | 41.949 → 2.824                   | 1,000 → 11                   | 1,000 → 201                 |
| 2,000     | 85.382 → 0.153                    | 85.029 → 17.470                  | 2,000 → 11                   | 2,000 → 401                 |
| 5,000     | 212.649 → 0.557                   | 205.513 → 45.129                 | 5,000 → 11                   | 5,000 → 1,001               |
| 10,000    | 414.715 → 0.534                   | 220.100 → 90.757                 | 10,000 → 11                  | 10,000 → 2,001              |

Bounded ranges decode one row beyond the upper boundary to stop traversal.
At 10,000 rows the numeric secondary range stayed at 10,000 reads and roughly
410 → 414 ms in the separate range run. The initial all-operation run had a
much faster numeric-range baseline (131 ms), illustrating timing variability;
there is no claimed improvement to that scan. Numeric secondary indexes mix
booleans and numbers, so bounded seeking could hide strict comparison errors.

Secondary equality still reads matching rows plus one boundary row. At 10,000
documents, category equality read 1,001 records both before and after, with
44.7 → 46.6 ms medians. Unindexed equality read 10,000 records (389.7 → 414.2 ms).
Sorting also remained a full candidate sort (431.7 → 433.2 ms). Grouping still
reads every candidate (433.1 → 431.1 ms), but now retains aggregate state rather
than every group member. No measured memory saving or top-K improvement is claimed.

Correctness tests cover duplicate values, numeric IDs, inclusive/exclusive
range bounds, index toggles, exact misses, early LIMIT, global sort/group/DISTINCT,
one semantic replacement/tombstone, binary/compression preservation, all-document
preflight and injected late encoder/commit failures.

## Independent regression rerun, 2026-10-10

The strengthened harness ran all 11 operations at 1,000 documents against
unchanged `29a34dc` and the working tree. Exact result values matched expectations
on both implementations. It also reran the four main operations at 10,000
documents with the same five warmups and 40 samples:

| Operation        | Before p50 / p95 (ms) | After p50 / p95 (ms) | Reads before → after |
| ---------------- | --------------------- | -------------------- | -------------------- |
| Exact ID         | 421.878 / 464.592     | 0.079 / 0.197        | 10,000 → 1           |
| LIMIT 10         | 408.235 / 452.596     | 0.210 / 0.338        | 10,000 → 10          |
| Primary range    | 414.516 / 459.421     | 0.293 / 0.433        | 10,000 → 11          |
| Two-field UPDATE | 155.747 / 451.361     | 0.526 / 0.920        | 10,005 → 3           |

The UPDATE now reads the original typed payload before replacement, preserving
Buffer fields that a JSON round trip previously changed into strings. It still
generates one embedding per replacement. The large baseline UPDATE p50/p95 gap
demonstrates timing variability; operation counts are stronger evidence than
the exact latency ratio. These remain mock-storage measurements, excluding
durable commit; some validation/browser activity overlapped the reruns.

Outputs use `audit-before-1000`, `audit-after-1000`, `audit-before-10000` and
`audit-after-10000` prefixes in the ignored results directory. Final timings
above use `audit-after-10000-verified`, rerun after the Unicode range-safety fix;
ASCII bounds still use bounded scans. Disk-backed SQL
lifecycle, codec/binary preservation, actual record/B+ tree/HNSW relocation,
vacuum and reopening are verified separately in `src/query/tests/integration.spec.mts`.
