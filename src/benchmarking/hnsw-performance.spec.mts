// HNSW Performance Benchmark (Rust-backed HNSWIndex with FBF persistence)
// Measures insertion and k-NN search performance with high-dimensional vectors.
// Run with: npx vitest run src/benchmarking/hnsw-performance.spec.mts --reporter=verbose
//
// Uses HNSWIndex backed by the Rust DLL — the same code path used in production.
// All graph computation runs in Rust; dirty nodes are persisted to a MockFile
// FreeBlockFile (in-memory) after each insert so the full pipeline is exercised.

import { describe, it } from 'vitest';
import { FreeBlockFile } from '../freeblockfile/freeblockfile.mjs';
import { AtomicFile } from '../atomic/atomicfile.mjs';
import { MockFile } from '../core/mockfile.mjs';
import { VectorHeapFile } from '../hnsw/vectorHeapFile.mjs';
import { HNSWGraphStorage } from '../hnsw/hnswGraphStorage.mjs';
import { HNSWIndex } from '../hnsw/hnswIndex.mjs';
import { writeFileSync, mkdirSync } from 'fs';

// ── Benchmark configuration ───────────────────────────────────────────────────

const DIM = 384; // embedding dimension
const INSERT_COUNT = 100000; // total vectors to insert per run
const M = 16; // HNSW connectivity parameter
const EF_CONSTRUCTION = 200; // beam width during construction
const EF_SEARCH = 128; // beam width during search
const K = 10; // k nearest neighbours to retrieve
const RUNS = 1; // independent runs averaged together
const SEARCH_QUERIES = 50; // queries fired at each search checkpoint
const SEARCH_INTERVAL = 200; // take a search sample every N inserts
const COMMIT_INTERVAL = 500; // flush WAL every N inserts (realistic workload)
const MAX_STORED_LEVEL = 6; // max graph level persisted per node
const BLOCK_SIZE = 4096; // FreeBlockFile block size in bytes

const RESULTS_DIR = 'src/benchmarking/results/';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeFbf(): Promise<FreeBlockFile> {
  const logSectorSize = BLOCK_SIZE * 16;
  const mockData = new MockFile(BLOCK_SIZE);
  const mockLog = new MockFile(logSectorSize);
  const atomicFile = new AtomicFile(mockData, mockLog);
  const fbf = new FreeBlockFile(atomicFile, BLOCK_SIZE);
  await fbf.create();
  return fbf;
}

/** Random L2-normalised float32 vector of length `dim`. */
function randomUnitVector(dim: number): Float32Array {
  const v = new Float32Array(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    v[i] = Math.random() * 2 - 1;
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(Math.ceil((p / 100) * sorted.length) - 1, sorted.length - 1);
  return sorted[idx];
}

// ── Benchmark ─────────────────────────────────────────────────────────────────

describe('HNSW Performance Benchmark', () => {
  it(
    `inserts ${INSERT_COUNT} × dim-${DIM} vectors and benchmarks k-NN search`,
    async () => {
      type CheckpointSample = { indexSize: number; rawTimes: number[] };

      const allInsertTimes: number[][] = [];
      const allCheckpoints: CheckpointSample[][] = [];

      for (let run = 0; run < RUNS; run++) {
        console.log(`\n── Run ${run + 1} / ${RUNS} ─────────────────────────────────────`);

        // Set up a fresh FreeBlockFile-backed index for each run.
        const fbf = await makeFbf();
        const graphStorage = await HNSWGraphStorage.create(fbf, M, MAX_STORED_LEVEL);
        const vectorHeap = new VectorHeapFile(fbf, DIM);
        const index = HNSWIndex.create(graphStorage, vectorHeap, {
          M,
          efConstruction: EF_CONSTRUCTION,
          efSearch: EF_SEARCH,
        });

        const insertTimes: number[] = [];
        const checkpoints: CheckpointSample[] = [];

        // Pre-generate all corpus vectors before timing begins.
        const vectors = Array.from({ length: INSERT_COUNT }, () => randomUnitVector(DIM));

        for (let i = 0; i < INSERT_COUNT; i++) {
          // ── Insert and time ──────────────────────────────────────────────
          const t0 = performance.now();
          await index.insert(i, vectors[i]);
          insertTimes.push(performance.now() - t0);

          // ── Periodic WAL flush (realistic production workload) ────────────
          if ((i + 1) % COMMIT_INTERVAL === 0) {
            await index.commit();
          }

          // ── Search checkpoint ────────────────────────────────────────────
          if ((i + 1) % SEARCH_INTERVAL === 0) {
            const rawTimes: number[] = [];
            for (let q = 0; q < SEARCH_QUERIES; q++) {
              const query = randomUnitVector(DIM);
              const t1 = performance.now();
              await index.search(query, K);
              rawTimes.push(performance.now() - t1);
            }
            checkpoints.push({ indexSize: i + 1, rawTimes });

            const recentInserts = insertTimes.slice(-SEARCH_INTERVAL);
            const avgInsert = recentInserts.reduce((a, b) => a + b) / recentInserts.length;
            const avgSearch = rawTimes.reduce((a, b) => a + b) / rawTimes.length;
            console.log(
              `  [${i + 1}/${INSERT_COUNT}]  insert: ${avgInsert.toFixed(3)} ms/op   search: ${avgSearch.toFixed(3)} ms/query`,
            );
          }
        }

        await index.close();
        allInsertTimes.push(insertTimes);
        allCheckpoints.push(checkpoints);
      }

      // ── Aggregate across runs ────────────────────────────────────────────

      // Per-insert average across runs
      const avgInsertTimes = allInsertTimes[0].map((_, i) => allInsertTimes.reduce((s, r) => s + r[i], 0) / RUNS);

      // Per-checkpoint summary (averaged across runs, raw times from last run)
      const checkpointCount = allCheckpoints[0].length;
      const searchCheckpoints = Array.from({ length: checkpointCount }, (_, ci) => {
        const indexSize = allCheckpoints[0][ci].indexSize;
        // Combine all times from all runs for this checkpoint
        const allTimes = allCheckpoints
          .flatMap((runCps) => runCps[ci].rawTimes)
          .slice()
          .sort((a, b) => a - b);
        return {
          indexSize,
          meanMs: allTimes.reduce((a, b) => a + b) / allTimes.length,
          p50Ms: percentile(allTimes, 50),
          p95Ms: percentile(allTimes, 95),
          p99Ms: percentile(allTimes, 99),
        };
      });

      // Raw times at the final checkpoint (from the last run, for histogram)
      const lastRunLastCheckpoint = allCheckpoints[RUNS - 1].at(-1);
      const searchTimesLastCheckpoint = lastRunLastCheckpoint?.rawTimes.slice().sort((a, b) => a - b) ?? [];

      // ── Print summary ──────────────────────────────────────────────────────
      const sortedInsert = [...avgInsertTimes].sort((a, b) => a - b);
      const meanInsert = avgInsertTimes.reduce((a, b) => a + b) / avgInsertTimes.length;
      const p95Insert = percentile(sortedInsert, 95);

      const lastCp = searchCheckpoints.at(-1)!;
      console.log('\n── Summary ─────────────────────────────────────────────────────');
      console.log(`  Dimension      : ${DIM}`);
      console.log(`  Vectors        : ${INSERT_COUNT}  |  Runs: ${RUNS}`);
      console.log(`  HNSW params    : M=${M}  efC=${EF_CONSTRUCTION}  efS=${EF_SEARCH}`);
      console.log(`  INSERT  mean   : ${meanInsert.toFixed(4)} ms   P95: ${p95Insert.toFixed(4)} ms`);
      console.log(
        `  SEARCH  mean   : ${lastCp.meanMs.toFixed(4)} ms   P50: ${lastCp.p50Ms.toFixed(4)} ms   P95: ${lastCp.p95Ms.toFixed(4)} ms   (at N=${lastCp.indexSize})`,
      );

      // ── Save results ────────────────────────────────────────────────────────
      mkdirSync(RESULTS_DIR, { recursive: true });
      const outPath = `${RESULTS_DIR}hnsw_performance.json`;
      writeFileSync(
        outPath,
        JSON.stringify(
          {
            config: {
              dim: DIM,
              insertCount: INSERT_COUNT,
              M,
              efConstruction: EF_CONSTRUCTION,
              efSearch: EF_SEARCH,
              k: K,
              runs: RUNS,
            },
            insertTimes: avgInsertTimes,
            searchCheckpoints,
            searchTimesLastCheckpoint,
          },
          null,
          2,
        ),
      );
      console.log(`\nResults saved → ${outPath}`);
      console.log('Plot with: cd src/benchmarking && python plot_hnsw.py');
    },
    60 * 60 * 1000, // 60-minute timeout
  );
});
