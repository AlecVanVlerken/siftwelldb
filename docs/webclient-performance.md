# Webclient deletion and vacuum measurements

These measurements compare collection deletion and full vacuum before and after removing repeated record reads. They use
disposable databases and deterministic embeddings to measure storage and index work separately from model inference.

Local disposable-file profiling used three runs per case and identical saved fixtures. Representative median operation
durations were:

| Workload                             |   Before |    After |
| ------------------------------------ | -------: | -------: |
| Delete 100 structured documents      |    47 ms |    29 ms |
| Delete 1,000 structured documents    |   177 ms |   139 ms |
| Delete 10,000 structured documents   | 1,572 ms | 1,296 ms |
| Delete 100 image documents           |   595 ms |   503 ms |
| Vacuum 1,000 structured documents    |   547 ms |   437 ms |
| Vacuum 500 compressed-text documents |   738 ms |   653 ms |
| Vacuum 300 semantic documents        |   235 ms |   223 ms |
| Vacuum 100 image documents           | 1,459 ms | 1,298 ms |

Vacuum fixtures also contained eight unrelated documents. Unrelated five-document reads waited for the deletion, then
executed in roughly 0.5–0.8 ms. The 10,000-row drop removed 10,000 redundant block reads; the image drop removed 4,540.
Structured vacuum validation fell from 212 to 105 ms, and image validation from 683 to 419 ms. An isolated
1,008-document core-vacuum comparison with/without an observer gave 320/327 ms medians; this is within runtime
variation, not a claimed speedup from reporting. The observer received 230 bounded phase/count events.

These are local instrumented measurements, not throughput guarantees. Fixtures used actual JPEG bytes and deterministic
embeddings to isolate storage/index costs. Real MiniLM/CLIP inference can dominate copying and was not accelerated.
Compression, copying, index construction, synchronization, replacement fingerprint checks and reopening still perform
necessary work. Queue waiting is retained.

See the [webclient guide](../src/webclient/README.md) for the operation flow.
