// HNSW Scientific Benchmark Suite
// ─────────────────────────────────────────────────────────────────────────────
// Comprehensive parameter-sweep experiments matching the methodology of the
// original HNSW paper (Malkov & Yashunin, 2018).
//
// Experiments
// ───────────
//   1. M sweep            (M = 8, 16, 24, 32)             — 200 K inserts each
//   2. efConstruction sweep (50, 100, 200)                 — 200 K inserts each
//   3. Single best-config  (M=32, efC=200, efS=200, dim=384)    — 1 M inserts
//   4. Dimension sweep     (64, 128, 256, 384, 512)        — 200 K inserts each
//
// Metrics collected
// ─────────────────
//   • Insert latency    : mean + P95 per SEARCH_INTERVAL-sized window
//   • k-NN search latency: mean + P50 + P95 at every checkpoint
//   • Recall@K (brute-force ground truth) for N ≤ RECALL_MAX_N
//   • Recall@K vs efSearch sweep at N = RECALL_SWEEP_N (1 M)
//
// All graph operations run in the Rust DLL via HnswIndexNative — no FBF
// persistence overhead, so measured latency reflects pure graph cost.
//
// Run each experiment SEPARATELY to see live output and stay within timeouts:
//   NODE_OPTIONS="--max-old-space-size=8192" npx vitest run src/benchmarking/hnsw-scientific.spec.mts --reporter=verbose --testNamePattern="Experiment 1"
//   NODE_OPTIONS="--max-old-space-size=8192" npx vitest run src/benchmarking/hnsw-scientific.spec.mts --reporter=verbose --testNamePattern="Experiment 2"
//   NODE_OPTIONS="--max-old-space-size=8192" npx vitest run src/benchmarking/hnsw-scientific.spec.mts --reporter=verbose --testNamePattern="Experiment 3"
//   NODE_OPTIONS="--max-old-space-size=8192" npx vitest run src/benchmarking/hnsw-scientific.spec.mts --reporter=verbose --testNamePattern="Experiment 4"
//
// Results → src/benchmarking/results/scientific/
// Plot    → cd src/benchmarking && python plot_hnsw_scientific.py

import { describe, it } from 'vitest';
import { HnswIndexNative } from '../hnsw/hnswNative.mjs';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { loadFvecs, loadIvecs } from './sift-loader.mjs';

// ── Global benchmark configuration ───────────────────────────────────────────

const K = 10; // number of nearest neighbours

// Performance experiment loop controls
const SEARCH_INTERVAL = 5_000; // search-latency checkpoint every N inserts
const SEARCH_QUERIES = 50; // queries fired at each search checkpoint

// Brute-force recall (only computed while index is small)
const RECALL_MAX_N = 10_000; // max N for brute-force ground truth
const RECALL_INTERVAL = 2_000; // recall checkpoint every N inserts (≤ RECALL_MAX_N)
const RECALL_QUERIES = 100; // test queries for recall measurement

// Recall-vs-efSearch sweep
// Mirrors the HNSW paper exactly: ground truth = brute-force over the FULL
// corpus of RECALL_SWEEP_N vectors.  Memory: 1 M × 384 × 4 = 1.5 GB — fine
// with --max-old-space-size=8192.  BF time: ~1–2 min for 100 queries (JS
// typed-array L2 over 1 M × 384 floats).  This is a one-time cost per config
// before the efSearch sweep loop, so it does not inflate the sweep timings.
const RECALL_SWEEP_N = 200_000; // full corpus size (HNSW index + BF ground truth)
const EF_SEARCH_VALS = [10, 16, 20, 32, 40, 64, 100, 128, 200, 256]; // values to test

// Experiment parameter grids
const M_VALUES = [8, 16, 24, 32];
const EFC_VALUES = [50, 100, 200];
const DIM_VALUES = [64, 128, 256, 384, 512];

// Multi-config recall sweep (varied M + efC)
const _RECALL_CONFIGS = [
  { M: 8, efC: 100, label: 'M8_efC100' },
  { M: 16, efC: 100, label: 'M16_efC100' },
  { M: 16, efC: 200, label: 'M16_efC200' },
  { M: 24, efC: 200, label: 'M24_efC200' },
  { M: 32, efC: 300, label: 'M32_efC300' },
];

// Insert counts — all experiments use 200 K vectors (laptop-friendly).
const FULL_N = 200_000; // for M and efC sweeps
const DIM_N = 200_000; // for dimension sweep

// Default parameter values (held fixed while varying the sweep parameter)
const DEFAULT_M = 16;
const DEFAULT_EFC = 200;
const DEFAULT_EFS = 128;
const DEFAULT_DIM = 384;

const RESULTS_DIR = 'src/benchmarking/results/scientific/';

// ── Shared random test queries (same seed-equivalent across experiments) ──────
// Generated once per category so recall curves across parameter values
// are measured against identical queries — making comparisons fair.

// ── Types ─────────────────────────────────────────────────────────────────────

type Checkpoint = {
  n: number; // current index size
  insertMeanMs: number; // mean insert latency over last SEARCH_INTERVAL inserts
  insertP95Ms: number;
  searchMeanMs: number; // mean k-NN query latency
  searchP50Ms: number;
  searchP95Ms: number;
};

type RecallPoint = {
  n: number;
  recallAtK: number; // fraction in [0, 1]
  hnswMeanMs: number; // HNSW query time
  bfMeanMs: number; // brute-force query time
};

type ExperimentResult = {
  label: string;
  params: {
    M: number;
    efConstruction: number;
    efSearch: number;
    dim: number;
    N: number;
    K: number;
  };
  checkpoints: Checkpoint[];
  recallPoints: RecallPoint[];
  totalWallMs: number;
};

type EfSearchPoint = {
  efSearch: number;
  recallAtK: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
};

type RecallSweepResult = {
  label: string;
  M: number;
  efConstruction: number;
  dim: number;
  indexSize: number; // = bfCorpusSize: ground truth computed over full corpus
  K: number;
  efSearchPoints: EfSearchPoint[];
};

// ── Utility helpers ───────────────────────────────────────────────────────────

/** Random L2-normalised float32 vector. */
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
  return sorted[Math.max(0, idx)];
}

/**
 * Exact k-NN over a flat (row-major, n×dim) Float32Array corpus.
 * Returns docIds sorted by ascending squared-L2 distance to `query`.
 */
function bruteForceKNN(corpus: Float32Array, n: number, dim: number, query: Float32Array, k: number): number[] {
  const dists = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let d = 0;
    const base = i * dim;
    for (let j = 0; j < dim; j++) {
      const diff = corpus[base + j] - query[j];
      d += diff * diff;
    }
    dists[i] = d;
  }
  const indices = Array.from({ length: n }, (_, i) => i);
  indices.sort((a, b) => dists[a] - dists[b]);
  return indices.slice(0, k);
}

/**
 * Compute recall@K for a set of test queries against exact brute-force.
 * Uses pre-built ground-truth sets for efficiency.
 */
function measureRecall(
  native: HnswIndexNative,
  groundTruths: Set<number>[],
  testQueries: Float32Array[],
  k: number,
): { recallAtK: number; hnswMeanMs: number } {
  let totalRecall = 0;
  let totalMs = 0;
  for (let q = 0; q < testQueries.length; q++) {
    const t0 = performance.now();
    const result = native.search(testQueries[q], k);
    totalMs += performance.now() - t0;
    const found = result.filter((id) => groundTruths[q].has(id)).length;
    totalRecall += found / k;
  }
  return {
    recallAtK: totalRecall / testQueries.length,
    hnswMeanMs: totalMs / testQueries.length,
  };
}

function saveJSON(filename: string, data: unknown): void {
  const path = RESULTS_DIR + filename;
  writeFileSync(path, JSON.stringify(data, null, 2));
  process.stdout.write(`  → saved ${path}\n`);
}

/** Format elapsed milliseconds as  "1h 23m 45s" or "12m 34s" or "45s". */
function elapsed(tStartMs: number): string {
  const s = Math.floor((performance.now() - tStartMs) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m ${sec.toString().padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${sec.toString().padStart(2, '0')}s`;
  return `${sec}s`;
}

function banner(title: string, params: string): void {
  const line = '═'.repeat(72);
  process.stdout.write(`\n${line}\n`);
  process.stdout.write(`  ${title}\n`);
  process.stdout.write(`  ${params}\n`);
  process.stdout.write(`${line}\n`);
}

// ── Core performance experiment ───────────────────────────────────────────────
//
// Builds an HNSW index to N vectors and records:
//   • insert latency window stats every SEARCH_INTERVAL inserts
//   • k-NN search latency at every checkpoint
//   • recall@K (vs brute force) while N ≤ RECALL_MAX_N
//
// All sampling uses pre-generated testQueries so results are reproducible
// across parameter sweeps.

function runPerfExperiment(
  label: string,
  M: number,
  efC: number,
  efS: number,
  dim: number,
  N: number,
  recallTestQueries: Float32Array[],
  recallCutoff: number = RECALL_MAX_N,
  recallInterval: number = RECALL_INTERVAL,
): ExperimentResult {
  banner(
    `EXPERIMENT: ${label}`,
    `M=${M}  efConstruction=${efC}  efSearch=${efS}  dim=${dim}  N=${N.toLocaleString()}  K=${K}`,
  );

  const native = new HnswIndexNative(dim, M, efC, efS);

  // Flat row-major corpus for brute-force recall (first recallCutoff vectors only)
  const corpusSmall = new Float32Array(recallCutoff * dim);

  // Pre-build brute-force ground truth lazily at each recall checkpoint
  const checkpoints: Checkpoint[] = [];
  const recallPoints: RecallPoint[] = [];
  let batchInsertTimes: number[] = [];

  const tWallStart = performance.now();
  let lastProgressLog = performance.now();
  process.stdout.write(`  started at ${new Date().toLocaleTimeString()}\n`);

  for (let i = 0; i < N; i++) {
    const v = randomUnitVector(dim);

    // Store in flat corpus for brute-force (while still small)
    if (i < recallCutoff) {
      corpusSmall.set(v, i * dim);
    }

    // Time the Rust insert
    const t0 = performance.now();
    native.insert(i, v);
    batchInsertTimes.push(performance.now() - t0);

    // ── Recall checkpoint (brute-force, only while index is small) ────────────
    if (i < recallCutoff && (i + 1) % recallInterval === 0) {
      const n = i + 1;
      process.stdout.write(
        `  [recall +${elapsed(tWallStart)}] n=${n.toLocaleString().padStart(9)}  computing BF ground truth (${recallTestQueries.length} queries × ${n.toLocaleString()} vectors)...\n`,
      );
      // Build exact ground truth for this corpus size
      const groundTruths = recallTestQueries.map((q) => new Set(bruteForceKNN(corpusSmall, n, dim, q, K)));
      const bfStart = performance.now();
      for (const rq of recallTestQueries) {
        bruteForceKNN(corpusSmall, n, dim, rq, K);
      }
      const bfMeanMs = (performance.now() - bfStart) / recallTestQueries.length;
      const { recallAtK, hnswMeanMs } = measureRecall(native, groundTruths, recallTestQueries, K);
      recallPoints.push({ n, recallAtK, hnswMeanMs, bfMeanMs });
      process.stdout.write(
        `  [recall +${elapsed(tWallStart)}] n=${n.toLocaleString().padStart(9)}  recall@${K}=${recallAtK.toFixed(4)}  hnsw=${hnswMeanMs.toFixed(3)}ms  bf=${bfMeanMs.toFixed(3)}ms\n`,
      );
    }

    // ── Search-latency checkpoint ─────────────────────────────────────────────
    if ((i + 1) % SEARCH_INTERVAL === 0) {
      const searchTimes: number[] = [];
      for (let q = 0; q < SEARCH_QUERIES; q++) {
        const query = randomUnitVector(dim);
        const t1 = performance.now();
        native.search(query, K);
        searchTimes.push(performance.now() - t1);
      }
      const ss = searchTimes.slice().sort((a, b) => a - b);
      const si = batchInsertTimes.slice().sort((a, b) => a - b);

      const cp: Checkpoint = {
        n: i + 1,
        insertMeanMs: batchInsertTimes.reduce((a, b) => a + b) / batchInsertTimes.length,
        insertP95Ms: percentile(si, 95),
        searchMeanMs: searchTimes.reduce((a, b) => a + b) / searchTimes.length,
        searchP50Ms: percentile(ss, 50),
        searchP95Ms: percentile(ss, 95),
      };
      checkpoints.push(cp);
      batchInsertTimes = []; // reset window

      // Progress: every 30 s or every 50 K inserts — always live via stdout.write
      const now = performance.now();
      if (now - lastProgressLog >= 30_000 || (i + 1) % 50_000 === 0) {
        const pct = (((i + 1) / N) * 100).toFixed(1);
        process.stdout.write(
          `  [perf  +${elapsed(tWallStart)}] ${pct.padStart(5)}%  n=${(i + 1).toLocaleString().padStart(9)}/${N.toLocaleString()}  ` +
            `insert=${cp.insertMeanMs.toFixed(3)}ms  search=${cp.searchMeanMs.toFixed(3)}ms\n`,
        );
        lastProgressLog = now;
      }
    }
  }

  native.close();

  const totalWallMs = performance.now() - tWallStart;
  process.stdout.write(`  ✓ ${label} completed in ${(totalWallMs / 1000).toFixed(1)} s\n`);

  const result: ExperimentResult = {
    label,
    params: { M, efConstruction: efC, efSearch: efS, dim, N, K },
    checkpoints,
    recallPoints,
    totalWallMs,
  };

  saveJSON(`${label}.json`, result);
  return result;
}

// ── Recall vs efSearch sweep ──────────────────────────────────────────────────
//
// Builds a 1 M-vector HNSW index with given (M, efC), then sweeps efSearch
// and reports recall@K + search latency for each value.  Uses the same
// randomly-generated query set (passed in) across all configs and sweep points,
// so the speed-recall tradeoff curves are directly comparable.

function _runRecallSweep(
  label: string,
  M: number,
  efC: number,
  dim: number,
  testQueries: Float32Array[],
): RecallSweepResult {
  banner(
    `RECALL SWEEP: ${label}`,
    `M=${M}  efConstruction=${efC}  dim=${dim}  N=${RECALL_SWEEP_N.toLocaleString()}  K=${K}`,
  );

  // Use efSearch=128 during build (will be overridden per sweep point during search)
  const native = new HnswIndexNative(dim, M, efC, 128);

  // Full corpus in JS — needed for brute-force ground truth (paper methodology).
  // Memory: RECALL_SWEEP_N × dim × 4 bytes = 1 M × 384 × 4 ≈ 1.5 GB.
  // Requires --max-old-space-size=8192.
  const corpus = new Float32Array(RECALL_SWEEP_N * dim);

  process.stdout.write(
    `  Inserting ${RECALL_SWEEP_N.toLocaleString()} vectors (full corpus kept for BF ground truth)...\n`,
  );
  const tBuild = performance.now();
  for (let i = 0; i < RECALL_SWEEP_N; i++) {
    const v = randomUnitVector(dim);
    corpus.set(v, i * dim);
    native.insert(i, v);
    if ((i + 1) % 50_000 === 0) {
      const pct = (((i + 1) / RECALL_SWEEP_N) * 100).toFixed(1);
      process.stdout.write(
        `\r    [+${elapsed(tBuild)}] ${pct.padStart(5)}%  ${(i + 1).toLocaleString()} / ${RECALL_SWEEP_N.toLocaleString()}   `,
      );
    }
  }
  process.stdout.write(
    `\r    built in ${((performance.now() - tBuild) / 1000).toFixed(1)} s                          \n`,
  );

  // Fixed test queries — distinct from the corpus (standard ANN-benchmarks setup).
  // testQueries passed in from the caller — shared across all configs so that
  // the speed-recall curves are measured against the identical query set.

  // Exact ground truth: brute-force over the FULL corpus — matches HNSW paper methodology.
  // Time estimate: ~1–2 min for 100 queries × 1 M × 384-dim in JS typed arrays.
  process.stdout.write(
    `  Computing brute-force ground truth over full ${RECALL_SWEEP_N.toLocaleString()}-vector corpus` +
      ` (${RECALL_QUERIES} queries)  — takes ~1–2 min...\n`,
  );
  const tBf = performance.now();
  const groundTruths: Set<number>[] = testQueries.map((q) => new Set(bruteForceKNN(corpus, RECALL_SWEEP_N, dim, q, K)));
  process.stdout.write(`  Ground truth done in ${((performance.now() - tBf) / 1000).toFixed(1)} s\n`);

  // Sweep efSearch
  const efSearchPoints: EfSearchPoint[] = [];
  for (const efS of EF_SEARCH_VALS) {
    native.setEfSearch(efS);

    let totalRecall = 0;
    const times: number[] = [];
    for (let q = 0; q < RECALL_QUERIES; q++) {
      const t0 = performance.now();
      const result = native.search(testQueries[q], K);
      times.push(performance.now() - t0);
      const found = result.filter((id) => groundTruths[q].has(id)).length;
      totalRecall += found / K;
    }
    const ss = times.slice().sort((a, b) => a - b);
    const pt: EfSearchPoint = {
      efSearch: efS,
      recallAtK: totalRecall / RECALL_QUERIES,
      meanMs: times.reduce((a, b) => a + b) / times.length,
      p50Ms: percentile(ss, 50),
      p95Ms: percentile(ss, 95),
    };
    efSearchPoints.push(pt);
    process.stdout.write(
      `    efSearch=${efS.toString().padStart(4)}:  recall@${K}=${pt.recallAtK.toFixed(4)}  ` +
        `mean=${pt.meanMs.toFixed(3)}ms  p95=${pt.p95Ms.toFixed(3)}ms\n`,
    );
  }

  native.close();

  const result: RecallSweepResult = {
    label,
    M,
    efConstruction: efC,
    dim,
    indexSize: RECALL_SWEEP_N,
    K,
    efSearchPoints,
  };
  saveJSON(`recall_sweep_${label}.json`, result);
  return result;
}

// ── Describe block ────────────────────────────────────────────────────────────

describe('HNSW Scientific Benchmark Suite', () => {
  // ── Experiment 1: M parameter sweep ─────────────────────────────────────────
  it(
    'Experiment 1 — M parameter sweep  (M = 8, 16, 24, 32 | 200 K vectors each)',
    () => {
      mkdirSync(RESULTS_DIR, { recursive: true });

      // Shared recall queries so recall curves are directly comparable
      const recallQueries = Array.from({ length: RECALL_QUERIES }, () => randomUnitVector(DEFAULT_DIM));

      const results: ExperimentResult[] = [];
      for (const M of M_VALUES) {
        const r = runPerfExperiment(`m_sweep_M${M}`, M, DEFAULT_EFC, DEFAULT_EFS, DEFAULT_DIM, FULL_N, recallQueries);
        results.push(r);
      }

      saveJSON('m_sweep_combined.json', {
        meta: {
          sweepParam: 'M',
          fixedParams: { efConstruction: DEFAULT_EFC, efSearch: DEFAULT_EFS, dim: DEFAULT_DIM, N: FULL_N, K },
          searchInterval: SEARCH_INTERVAL,
          recallMaxN: RECALL_MAX_N,
          recallInterval: RECALL_INTERVAL,
        },
        experiments: results,
      });
    },
    4 * 60 * 60 * 1000, // 4-hour timeout
  );

  // ── Experiment 2: efConstruction sweep ───────────────────────────────────────
  it(
    'Experiment 2 — efConstruction sweep  (50, 100, 200 | 200 K vectors each)',
    () => {
      mkdirSync(RESULTS_DIR, { recursive: true });

      const recallQueries = Array.from({ length: RECALL_QUERIES }, () => randomUnitVector(DEFAULT_DIM));

      const results: ExperimentResult[] = [];
      for (const efC of EFC_VALUES) {
        const r = runPerfExperiment(
          `efc_sweep_efC${efC}`,
          DEFAULT_M,
          efC,
          DEFAULT_EFS,
          DEFAULT_DIM,
          FULL_N,
          recallQueries,
        );
        results.push(r);
      }

      saveJSON('efc_sweep_combined.json', {
        meta: {
          sweepParam: 'efConstruction',
          fixedParams: { M: DEFAULT_M, efSearch: DEFAULT_EFS, dim: DEFAULT_DIM, N: FULL_N, K },
          searchInterval: SEARCH_INTERVAL,
          recallMaxN: RECALL_MAX_N,
          recallInterval: RECALL_INTERVAL,
        },
        experiments: results,
      });
    },
    6 * 60 * 60 * 1000, // 6-hour timeout (efC=400 is slower)
  );

  // ── Experiment 3: single best-config production run ───────────────────────────
  //
  // Parameters: M=32, efC=200, efS=200, dim=384, N=1M
  //   — M=32 and efC=200 are the paper’s high-quality point
  //   — efS=200 matches efC so search quality equals build quality
  //   — dim=384 matches real embedding models (all-MiniLM-L6-v2 etc.)
  //
  // Brute-force ground truth is stored for the FULL 1M corpus (1.5 GB JS memory)
  // and sampled every 50K inserts – giving 20 recall checkpoints across 0→1M.
  // Requires:  NODE_OPTIONS="--max-old-space-size=8192"
  //
  // Expected runtime: ~20–40 min (M=32 + dim=384 is the heaviest config).
  it(
    'Experiment 3 — single best-config  (M=32 | efC=200 | efS=200 | dim=384 | 1 M vectors)',
    () => {
      mkdirSync(RESULTS_DIR, { recursive: true });

      const EXP3_M = 32;
      const EXP3_EFC = 200;
      const EXP3_EFS = 200;
      const EXP3_DIM = 384;
      const EXP3_N = 1_000_000;

      const recallQueries = Array.from({ length: RECALL_QUERIES }, () => randomUnitVector(EXP3_DIM));

      const r = runPerfExperiment(
        'best_config_M32_efC200_efS200_dim384',
        EXP3_M,
        EXP3_EFC,
        EXP3_EFS,
        EXP3_DIM,
        EXP3_N,
        recallQueries,
        EXP3_N, // recallCutoff = full corpus → recall measured all the way to 1M
        50_000, // recallInterval — 20 checkpoints; BF over dim=384 is ~2–4 s each
      );

      saveJSON('best_config.json', {
        meta: {
          fixedParams: { M: EXP3_M, efConstruction: EXP3_EFC, efSearch: EXP3_EFS, dim: EXP3_DIM, N: EXP3_N, K },
          searchInterval: SEARCH_INTERVAL,
          recallInterval: 50_000,
          note: 'Single best-config production run — M=32, efC=efS=200, dim=384, 1M vectors',
        },
        experiment: r,
      });
    },
    4 * 60 * 60 * 1000, // 4-hour timeout
  );

  // ── Experiment 4: dimension sweep ─────────────────────────────────────────────
  it(
    'Experiment 4 — dimension sweep  (64, 128, 256, 384, 512 | 200 K vectors each)',
    () => {
      mkdirSync(RESULTS_DIR, { recursive: true });

      const results: ExperimentResult[] = [];
      for (const dim of DIM_VALUES) {
        // Generate recall queries in the target dimension
        const recallQueries = Array.from({ length: RECALL_QUERIES }, () => randomUnitVector(dim));
        const r = runPerfExperiment(
          `dim_sweep_dim${dim}`,
          DEFAULT_M,
          DEFAULT_EFC,
          DEFAULT_EFS,
          dim,
          DIM_N,
          recallQueries,
        );
        results.push(r);
      }

      saveJSON('dim_sweep_combined.json', {
        meta: {
          sweepParam: 'dim',
          fixedParams: { M: DEFAULT_M, efConstruction: DEFAULT_EFC, efSearch: DEFAULT_EFS, N: DIM_N, K },
          searchInterval: SEARCH_INTERVAL,
          recallMaxN: RECALL_MAX_N,
          recallInterval: RECALL_INTERVAL,
        },
        experiments: results,
      });
    },
    8 * 60 * 60 * 1000, // 8-hour timeout (6 dims × 1 M inserts)
  );

  // ── Experiment 5: SIFT-1M structured data benchmark ─────────────────────────
  //
  // Uses the standard SIFT-1M dataset (128D, 1 M base vectors, 10 K queries with
  // pre-computed ground truth) — the same dataset used in the original HNSW paper
  // (Malkov & Yashunin, 2018).
  //
  // Unlike random vectors where pairwise distances concentrate around √2,
  // SIFT descriptors have real structure and well-separated neighbors, so
  // recall@10 should reach 0.95+ with M=16 and efSearch≥100.
  //
  // Download the dataset before running:
  //   cd src/benchmarking/datasets
  //   curl -O ftp://ftp.irisa.fr/local/texmex/corpus/sift.tar.gz
  //   tar xzf sift.tar.gz && rm sift.tar.gz
  //
  // Two M values (16, 32) × efSearch sweep → produces recall-vs-QPS curves
  // directly comparable to the paper's Figure 6.
  it(
    'Experiment 5 — SIFT-1M benchmark  (M=16,32 | efC=200 | 1 M structured vectors)',
    () => {
      mkdirSync(RESULTS_DIR, { recursive: true });

      const SIFT_DIR = 'src/benchmarking/datasets/sift';
      const baseFile = `${SIFT_DIR}/sift_base.fvecs`;
      const queryFile = `${SIFT_DIR}/sift_query.fvecs`;
      const gtFile = `${SIFT_DIR}/sift_groundtruth.ivecs`;

      if (!existsSync(baseFile)) {
        process.stdout.write(
          `\n  ✗ SIFT-1M dataset not found at ${SIFT_DIR}/\n` +
            `    Download it first:\n` +
            `      cd src/benchmarking/datasets\n` +
            `      curl -O ftp://ftp.irisa.fr/local/texmex/corpus/sift.tar.gz\n` +
            `      tar xzf sift.tar.gz && rm sift.tar.gz\n\n`,
        );
        return;
      }

      // Load dataset
      process.stdout.write('  Loading SIFT-1M dataset...\n');
      const base = loadFvecs(baseFile);
      const queries = loadFvecs(queryFile);
      const gt = loadIvecs(gtFile);
      process.stdout.write(
        `    base:    ${base.count.toLocaleString()} vectors, ${base.dim}D\n` +
          `    queries: ${queries.count.toLocaleString()} vectors\n` +
          `    ground truth: ${gt.count.toLocaleString()} queries × ${gt.k} neighbors\n`,
      );

      const SIFT_M_VALUES = [16, 32];
      const SIFT_EFC = 200;
      // Denser sweep for smooth recall-vs-QPS curve (matches paper methodology)
      const SIFT_EF_SEARCH_VALS = [1, 2, 4, 8, 10, 16, 20, 32, 40, 64, 100, 128, 200, 300, 500];

      // Re-usable buffer for FFI-safe vector copies (byteOffset must be 0)
      const vecBuf = new Float32Array(base.dim);

      const allResults: {
        M: number;
        efConstruction: number;
        dim: number;
        N: number;
        K: number;
        buildTimeMs: number;
        insertCheckpoints: { n: number; insertMeanMs: number; insertP95Ms: number }[];
        efSearchSweep: {
          efSearch: number;
          recallAt1: number;
          recallAtK: number;
          meanMs: number;
          p50Ms: number;
          p95Ms: number;
          qps: number;
        }[];
      }[] = [];

      const tExpStart = performance.now();

      for (const M of SIFT_M_VALUES) {
        const tConfigStart = performance.now();
        banner('SIFT-1M BENCHMARK', `M=${M}  efC=${SIFT_EFC}  dim=${base.dim}  N=${base.count.toLocaleString()}`);

        const native = new HnswIndexNative(base.dim, M, SIFT_EFC, 128);

        // ── Phase 1: Insert all 1 M vectors ───────────────────────────────────
        const insertCheckpoints: { n: number; insertMeanMs: number; insertP95Ms: number }[] = [];
        let batchTimes: number[] = [];
        const tBuild = performance.now();

        for (let i = 0; i < base.count; i++) {
          // Copy into FFI-safe buffer (koffi needs byteOffset=0)
          vecBuf.set(base.data.subarray(i * base.dim, (i + 1) * base.dim));
          const t0 = performance.now();
          native.insert(i, vecBuf);
          batchTimes.push(performance.now() - t0);

          if ((i + 1) % SEARCH_INTERVAL === 0) {
            const si = batchTimes.slice().sort((a, b) => a - b);
            insertCheckpoints.push({
              n: i + 1,
              insertMeanMs: batchTimes.reduce((a, b) => a + b) / batchTimes.length,
              insertP95Ms: percentile(si, 95),
            });
            batchTimes = [];
          }

          // Progress every 10K for the first 50K, then every 50K
          const logEvery = i + 1 <= 50_000 ? 10_000 : 50_000;
          if ((i + 1) % logEvery === 0) {
            const pct = (((i + 1) / base.count) * 100).toFixed(1);
            const last = insertCheckpoints.at(-1);
            process.stdout.write(
              `  [+${elapsed(tBuild)}] ${pct.padStart(5)}%  n=${(i + 1).toLocaleString().padStart(11)}  ` +
                `insert=${last ? last.insertMeanMs.toFixed(3) : '?'}ms\n`,
            );
          }
        }

        const buildTimeMs = performance.now() - tBuild;
        process.stdout.write(`  ✓ Build done in ${(buildTimeMs / 1000).toFixed(1)}s\n`);

        // ── Phase 2: efSearch sweep using pre-computed ground truth ──────────
        process.stdout.write(
          `  Sweeping efSearch (${queries.count.toLocaleString()} queries, ground truth pre-computed)...\n`,
        );

        const queryBuf = new Float32Array(base.dim);
        const efSearchSweep: {
          efSearch: number;
          recallAt1: number;
          recallAtK: number;
          meanMs: number;
          p50Ms: number;
          p95Ms: number;
          qps: number;
        }[] = [];

        for (const efS of SIFT_EF_SEARCH_VALS) {
          native.setEfSearch(efS);

          let totalRecallAtK = 0;
          let totalRecallAt1 = 0;
          const times: number[] = [];

          for (let q = 0; q < queries.count; q++) {
            queryBuf.set(queries.data.subarray(q * base.dim, (q + 1) * base.dim));
            const t0 = performance.now();
            const result = native.search(queryBuf, K);
            times.push(performance.now() - t0);

            // Ground truth: first K entries of row q (sorted by distance)
            const gtSetK = new Set<number>();
            for (let j = 0; j < K; j++) {
              gtSetK.add(gt.data[q * gt.k + j]);
            }
            const foundK = result.filter((id) => gtSetK.has(id)).length;
            totalRecallAtK += foundK / K;

            // recall@1: did we find the actual nearest neighbor?
            const gt1 = gt.data[q * gt.k]; // ground-truth NN
            if (result.length > 0 && result[0] === gt1) totalRecallAt1 += 1;
          }

          const ss = times.slice().sort((a, b) => a - b);
          const meanMs = times.reduce((a, b) => a + b) / times.length;
          const point = {
            efSearch: efS,
            recallAt1: totalRecallAt1 / queries.count,
            recallAtK: totalRecallAtK / queries.count,
            meanMs,
            p50Ms: percentile(ss, 50),
            p95Ms: percentile(ss, 95),
            qps: 1000 / meanMs,
          };
          efSearchSweep.push(point);

          process.stdout.write(
            `    efSearch=${efS.toString().padStart(4)}:  recall@1=${point.recallAt1.toFixed(4)}  ` +
              `recall@${K}=${point.recallAtK.toFixed(4)}  ` +
              `${point.qps.toFixed(0).padStart(6)} QPS  mean=${meanMs.toFixed(3)}ms  p95=${point.p95Ms.toFixed(3)}ms\n`,
          );
        }

        native.close();

        process.stdout.write(
          `  ✓ M=${M} complete — total ${((performance.now() - tConfigStart) / 1000 / 60).toFixed(1)} min\n`,
        );

        allResults.push({
          M,
          efConstruction: SIFT_EFC,
          dim: base.dim,
          N: base.count,
          K,
          buildTimeMs,
          insertCheckpoints,
          efSearchSweep,
        });
      }

      process.stdout.write(
        `\n  ════ ALL DONE — total ${((performance.now() - tExpStart) / 1000 / 60).toFixed(1)} min ════\n\n`,
      );

      saveJSON('sift_benchmark.json', {
        meta: {
          dataset: 'SIFT-1M',
          source: 'http://corpus-texmex.irisa.fr/',
          dim: base.dim,
          baseVectors: base.count,
          queryVectors: queries.count,
          groundTruthK: gt.k,
          K,
          M_VALUES: SIFT_M_VALUES,
          efConstruction: SIFT_EFC,
          efSearchValues: SIFT_EF_SEARCH_VALS,
        },
        experiments: allResults,
      });
    },
    8 * 60 * 60 * 1000,
  );
});
