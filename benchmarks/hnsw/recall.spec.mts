import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import {
  cleanupStorage,
  createBenchmarkIndex,
  envBoolean,
  envNumber,
  envNumberList,
  envString,
  mean,
  openBenchmarkIndex,
  percentile,
  renderProgressLine,
  resolveStorageMode,
  writeJsonResult,
} from './common.mjs';
import { inspectFvecs, loadFvecs, loadIvecs, streamFvecs, type LoadedFvecs } from './texmex.mjs';

const BLOCK_SIZE = envNumber('HNSW_BLOCK_SIZE', 4096);
const MAX_STORED_LEVEL = envNumber('HNSW_MAX_STORED_LEVEL', 6);
const M = envNumber('HNSW_M', 16);
const EF_CONSTRUCTION = envNumber('HNSW_EF_CONSTRUCTION', 200);
const BUILD_EF_SEARCH = envNumber('HNSW_EF_SEARCH', 128);
const K = envNumber('HNSW_K', 10);
const COMMIT_INTERVAL = envNumber('HNSW_COMMIT_INTERVAL', 500);
const SWEEP_VALUES = envNumberList('HNSW_RECALL_EF_SEARCH_VALUES', [8, 16, 32, 64, 96, 128, 200, 300, 500]);
const KEEP_DB_FILES = envBoolean('HNSW_KEEP_DB', false);
const STORAGE_MODE = resolveStorageMode('real');

const SIFT_DIR = envString('HNSW_SIFT_DIR', join('benchmarks', 'hnsw', 'datasets', 'sift'));
const GIST_DIR = envString('HNSW_GIST_DIR', join('benchmarks', 'hnsw', 'datasets', 'gist'));

const SIFT_BASE_FILE = join(SIFT_DIR, envString('HNSW_SIFT_BASE_FILE', 'sift_base.fvecs'));
const SIFT_QUERY_FILE = join(SIFT_DIR, envString('HNSW_SIFT_QUERY_FILE', 'sift_query.fvecs'));
const SIFT_GT_FILE = join(SIFT_DIR, envString('HNSW_SIFT_GT_FILE', 'sift_groundtruth.ivecs'));
const GIST_BASE_FILE = join(GIST_DIR, envString('HNSW_GIST_BASE_FILE', 'gist_base.fvecs'));
const GIST_QUERY_FILE = join(GIST_DIR, envString('HNSW_GIST_QUERY_FILE', 'gist_query.fvecs'));
const GIST_GT_FILE = join(GIST_DIR, envString('HNSW_GIST_GT_FILE', 'gist_groundtruth.ivecs'));

const SIFT_LIMIT = envNumber('HNSW_SIFT_LIMIT', 1_000_000);
const GIST_LIMIT = envNumber('HNSW_GIST_LIMIT', 1_000_000);
const DATASET_QUERY_LIMIT = envNumber('HNSW_RECALL_QUERY_LIMIT', 10_000);

const RANDOM_DIM = envNumber('HNSW_RANDOM_DIM', 128);
const RANDOM_COUNT = envNumber('HNSW_RANDOM_COUNT', 1_000_000);
const RANDOM_QUERY_COUNT = envNumber('HNSW_RANDOM_QUERY_COUNT', 100);
const RANDOM_SEED = envNumber('HNSW_RANDOM_SEED', 1337);
const RANDOM_QUERY_SEED = envNumber('HNSW_RANDOM_QUERY_SEED', 7331);

type RecallPoint = {
  efSearch: number;
  recallAtK: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  qps: number;
};

function requireDatasetFiles(datasetName: string, files: string[]): void {
  const missing = files.filter((filePath) => !existsSync(filePath));
  if (missing.length === 0) return;
  throw new Error(
    `${datasetName} dataset is missing.\n` +
      `${missing.map((filePath) => `  - ${filePath}`).join('\n')}\n\n` +
      `Extract the dataset under the matching directory before running this benchmark.`,
  );
}

function compactGroundTruth(gtData: Int32Array, rowWidth: number, queryCount: number, k: number): Int32Array {
  const compact = new Int32Array(queryCount * k);
  for (let queryIndex = 0; queryIndex < queryCount; queryIndex++) {
    for (let neighborIndex = 0; neighborIndex < k; neighborIndex++) {
      compact[queryIndex * k + neighborIndex] = gtData[queryIndex * rowWidth + neighborIndex];
    }
  }
  return compact;
}

function overlapCount(result: readonly number[], groundTruth: Int32Array, offset: number, k: number): number {
  let matches = 0;
  for (let resultIndex = 0; resultIndex < Math.min(result.length, k); resultIndex++) {
    const candidate = result[resultIndex];
    for (let truthIndex = 0; truthIndex < k; truthIndex++) {
      if (candidate === groundTruth[offset + truthIndex]) {
        matches += 1;
        break;
      }
    }
  }
  return matches;
}

function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fillRandomUnitVector(target: Float32Array, nextRandom: () => number): void {
  let norm = 0;
  for (let index = 0; index < target.length; index++) {
    const value = nextRandom() * 2 - 1;
    target[index] = value;
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  for (let index = 0; index < target.length; index++) {
    target[index] /= norm;
  }
}

function topKBruteForce(corpus: Float32Array, count: number, dim: number, query: Float32Array, k: number): Int32Array {
  const bestIds = new Int32Array(k);
  const bestDistances = new Float64Array(k);
  bestIds.fill(-1);
  bestDistances.fill(Number.POSITIVE_INFINITY);

  for (let vectorIndex = 0; vectorIndex < count; vectorIndex++) {
    const baseOffset = vectorIndex * dim;
    let distance = 0;
    for (let dimIndex = 0; dimIndex < dim; dimIndex++) {
      const diff = corpus[baseOffset + dimIndex] - query[dimIndex];
      distance += diff * diff;
    }

    if (distance >= bestDistances[k - 1]) continue;

    let insertAt = k - 1;
    while (insertAt > 0 && distance < bestDistances[insertAt - 1]) {
      bestDistances[insertAt] = bestDistances[insertAt - 1];
      bestIds[insertAt] = bestIds[insertAt - 1];
      insertAt -= 1;
    }

    bestDistances[insertAt] = distance;
    bestIds[insertAt] = vectorIndex;
  }

  return bestIds;
}

async function buildIndexFromTexmex(args: { label: string; baseFile: string; insertCount: number; dimension: number }) {
  const { descriptor, graphStorage, index } = await createBenchmarkIndex({
    label: args.label,
    dimension: args.dimension,
    blockSize: BLOCK_SIZE,
    maxStoredLevel: MAX_STORED_LEVEL,
    keepFiles: KEEP_DB_FILES,
    storageMode: STORAGE_MODE,
    params: {
      M,
      efConstruction: EF_CONSTRUCTION,
      efSearch: BUILD_EF_SEARCH,
    },
  });

  const buildStartedAt = performance.now();
  let totalInsertMs = 0;

  await streamFvecs(
    args.baseFile,
    async (vector, indexOffset) => {
      const insertOrdinal = indexOffset + 1;
      const insertStartedAt = performance.now();
      await index.insert(indexOffset, vector);
      totalInsertMs += performance.now() - insertStartedAt;

      if (insertOrdinal % COMMIT_INTERVAL === 0) {
        await index.commit();
      }

      const shouldLog =
        insertOrdinal === args.insertCount ||
        (insertOrdinal <= 50_000 ? insertOrdinal % 10_000 === 0 : insertOrdinal % 50_000 === 0);

      if (!shouldLog) return;

      process.stdout.write(
        renderProgressLine(
          `${args.label} build`,
          insertOrdinal,
          args.insertCount,
          buildStartedAt,
          `insert=${(totalInsertMs / insertOrdinal).toFixed(3)}ms\n`,
        ),
      );
    },
    { limit: args.insertCount },
  );

  if (args.insertCount % COMMIT_INTERVAL !== 0) {
    await index.commit();
  }

  await index.close();

  return {
    descriptor,
    metaBlockId: graphStorage.metaBlockId,
    buildStats: {
      totalWallMs: performance.now() - buildStartedAt,
      insertMeanMs: totalInsertMs / args.insertCount,
    },
  };
}

async function evaluateRecallSweep(args: {
  label: string;
  descriptor: Awaited<ReturnType<typeof createBenchmarkIndex>>['descriptor'];
  metaBlockId: number;
  dimension: number;
  queries: LoadedFvecs;
  groundTruthTopK: Int32Array;
}): Promise<RecallPoint[]> {
  const points: RecallPoint[] = [];
  const sweepStartedAt = performance.now();
  const queryBuffer = new Float32Array(args.queries.dim);
  const queryLogInterval = Math.max(1, Math.floor(args.queries.count / 10));

  for (let efIndex = 0; efIndex < SWEEP_VALUES.length; efIndex++) {
    const efSearch = SWEEP_VALUES[efIndex];
    const { index } = await openBenchmarkIndex({
      descriptor: args.descriptor,
      metaBlockId: args.metaBlockId,
      dimension: args.dimension,
      efSearch,
      efConstruction: EF_CONSTRUCTION,
    });

    const efStartedAt = performance.now();
    let matches = 0;
    const latencies: number[] = [];

    try {
      for (let queryIndex = 0; queryIndex < args.queries.count; queryIndex++) {
        queryBuffer.set(args.queries.data.subarray(queryIndex * args.queries.dim, (queryIndex + 1) * args.queries.dim));
        const searchStartedAt = performance.now();
        const result = await index.search(queryBuffer, K);
        latencies.push(performance.now() - searchStartedAt);
        matches += overlapCount(result, args.groundTruthTopK, queryIndex * K, K);

        const shouldLog = queryIndex + 1 === args.queries.count || (queryIndex + 1) % queryLogInterval === 0;
        if (shouldLog) {
          process.stdout.write(
            renderProgressLine(
              `${args.label} ef=${efSearch}`,
              queryIndex + 1,
              args.queries.count,
              efStartedAt,
              `partialRecall=${(matches / ((queryIndex + 1) * K)).toFixed(4)}\n`,
            ),
          );
        }
      }
    } finally {
      await index.close();
    }

    const sortedLatencies = latencies.slice().sort((left, right) => left - right);
    const meanMs = mean(latencies);
    const recallAtK = matches / (args.queries.count * K);
    points.push({
      efSearch,
      recallAtK,
      meanMs,
      p50Ms: percentile(sortedLatencies, 50),
      p95Ms: percentile(sortedLatencies, 95),
      qps: meanMs > 0 ? 1000 / meanMs : 0,
    });

    process.stdout.write(
      renderProgressLine(
        `${args.label} sweep`,
        efIndex + 1,
        SWEEP_VALUES.length,
        sweepStartedAt,
        `efSearch=${efSearch}  recall=${recallAtK.toFixed(4)}  latency=${meanMs.toFixed(3)}ms\n`,
      ),
    );
  }

  return points;
}

async function runTexmexRecallBenchmark(args: {
  datasetLabel: string;
  baseFile: string;
  queryFile: string;
  groundTruthFile: string;
  insertLimit: number;
  resultFile: string;
  source: string;
}) {
  requireDatasetFiles(args.datasetLabel, [args.baseFile, args.queryFile, args.groundTruthFile]);

  const baseInfo = await inspectFvecs(args.baseFile);
  const insertCount = Math.min(args.insertLimit, baseInfo.count);
  const queries = await loadFvecs(args.queryFile, DATASET_QUERY_LIMIT);
  const groundTruth = await loadIvecs(args.groundTruthFile, queries.count);

  if (queries.dim !== baseInfo.dim) {
    throw new Error(`${args.datasetLabel}: query dim ${queries.dim} does not match base dim ${baseInfo.dim}.`);
  }
  if (groundTruth.k < K) {
    throw new Error(`${args.datasetLabel}: ground truth width ${groundTruth.k} is smaller than K=${K}.`);
  }

  const { descriptor, metaBlockId, buildStats } = await buildIndexFromTexmex({
    label: args.datasetLabel.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
    baseFile: args.baseFile,
    insertCount,
    dimension: baseInfo.dim,
  });

  try {
    const points = await evaluateRecallSweep({
      label: args.datasetLabel,
      descriptor,
      metaBlockId,
      dimension: baseInfo.dim,
      queries,
      groundTruthTopK: compactGroundTruth(groundTruth.data, groundTruth.k, queries.count, K),
    });

    const resultPath = writeJsonResult(args.resultFile, {
      meta: {
        dataset: args.datasetLabel,
        source: args.source,
        dimension: baseInfo.dim,
        insertCount,
        queryCount: queries.count,
        K,
        M,
        efConstruction: EF_CONSTRUCTION,
        buildEfSearch: BUILD_EF_SEARCH,
        efSearchValues: SWEEP_VALUES,
        blockSize: BLOCK_SIZE,
        maxStoredLevel: MAX_STORED_LEVEL,
        storageMode: STORAGE_MODE,
      },
      build: buildStats,
      points,
    });

    process.stdout.write(`Saved recall results to ${resultPath}\n`);
  } finally {
    cleanupStorage(descriptor);
  }
}

async function runRandomRecallBenchmark(): Promise<void> {
  const { descriptor, graphStorage, index } = await createBenchmarkIndex({
    label: 'random_1m_128d',
    dimension: RANDOM_DIM,
    blockSize: BLOCK_SIZE,
    maxStoredLevel: MAX_STORED_LEVEL,
    keepFiles: KEEP_DB_FILES,
    storageMode: STORAGE_MODE,
    params: {
      M,
      efConstruction: EF_CONSTRUCTION,
      efSearch: BUILD_EF_SEARCH,
    },
  });

  const corpus = new Float32Array(RANDOM_COUNT * RANDOM_DIM);
  const vectorBuffer = new Float32Array(RANDOM_DIM);
  const nextCorpusRandom = createMulberry32(RANDOM_SEED);
  const buildStartedAt = performance.now();
  let totalInsertMs = 0;
  let buildIndexClosed = false;
  const metaBlockId = graphStorage.metaBlockId;

  try {
    for (let vectorIndex = 0; vectorIndex < RANDOM_COUNT; vectorIndex++) {
      fillRandomUnitVector(vectorBuffer, nextCorpusRandom);
      corpus.set(vectorBuffer, vectorIndex * RANDOM_DIM);

      const insertStartedAt = performance.now();
      await index.insert(vectorIndex, vectorBuffer);
      totalInsertMs += performance.now() - insertStartedAt;

      const insertOrdinal = vectorIndex + 1;
      if (insertOrdinal % COMMIT_INTERVAL === 0) {
        await index.commit();
      }

      const shouldLog =
        insertOrdinal === RANDOM_COUNT ||
        (insertOrdinal <= 50_000 ? insertOrdinal % 10_000 === 0 : insertOrdinal % 50_000 === 0);

      if (!shouldLog) continue;

      process.stdout.write(
        renderProgressLine(
          'random build',
          insertOrdinal,
          RANDOM_COUNT,
          buildStartedAt,
          `insert=${(totalInsertMs / insertOrdinal).toFixed(3)}ms\n`,
        ),
      );
    }

    if (RANDOM_COUNT % COMMIT_INTERVAL !== 0) {
      await index.commit();
    }

    await index.close();
    buildIndexClosed = true;

    const nextQueryRandom = createMulberry32(RANDOM_QUERY_SEED);
    const queryData = new Float32Array(RANDOM_QUERY_COUNT * RANDOM_DIM);
    for (let queryIndex = 0; queryIndex < RANDOM_QUERY_COUNT; queryIndex++) {
      const queryBuffer = queryData.subarray(queryIndex * RANDOM_DIM, (queryIndex + 1) * RANDOM_DIM);
      fillRandomUnitVector(queryBuffer, nextQueryRandom);
    }

    const groundTruth = new Int32Array(RANDOM_QUERY_COUNT * K);
    const bruteForceStartedAt = performance.now();
    for (let queryIndex = 0; queryIndex < RANDOM_QUERY_COUNT; queryIndex++) {
      const query = queryData.subarray(queryIndex * RANDOM_DIM, (queryIndex + 1) * RANDOM_DIM);
      groundTruth.set(topKBruteForce(corpus, RANDOM_COUNT, RANDOM_DIM, query, K), queryIndex * K);
      process.stdout.write(
        renderProgressLine('random exact', queryIndex + 1, RANDOM_QUERY_COUNT, bruteForceStartedAt, '\n'),
      );
    }

    const points = await evaluateRecallSweep({
      label: 'Random 1M 128D',
      descriptor,
      metaBlockId,
      dimension: RANDOM_DIM,
      queries: {
        dim: RANDOM_DIM,
        count: RANDOM_QUERY_COUNT,
        data: queryData,
      },
      groundTruthTopK: groundTruth,
    });

    const resultPath = writeJsonResult('recall_random_1m_128d.json', {
      meta: {
        dataset: 'Random 1M 128D',
        source: 'generated',
        dimension: RANDOM_DIM,
        insertCount: RANDOM_COUNT,
        queryCount: RANDOM_QUERY_COUNT,
        K,
        M,
        efConstruction: EF_CONSTRUCTION,
        buildEfSearch: BUILD_EF_SEARCH,
        efSearchValues: SWEEP_VALUES,
        blockSize: BLOCK_SIZE,
        maxStoredLevel: MAX_STORED_LEVEL,
        storageMode: STORAGE_MODE,
        randomSeed: RANDOM_SEED,
        randomQuerySeed: RANDOM_QUERY_SEED,
        bruteForceGroundTruthMs: performance.now() - bruteForceStartedAt,
      },
      build: {
        totalWallMs: performance.now() - buildStartedAt,
        insertMeanMs: totalInsertMs / RANDOM_COUNT,
      },
      points,
    });

    process.stdout.write(`Saved recall results to ${resultPath}\n`);
  } finally {
    if (!buildIndexClosed) {
      await index.close();
    }
    cleanupStorage(descriptor);
  }
}

describe('HNSWIndex recall benchmark', () => {
  it(
    'measures SIFT1M recall through HNSWIndex',
    async () => {
      await runTexmexRecallBenchmark({
        datasetLabel: 'SIFT1M',
        baseFile: SIFT_BASE_FILE,
        queryFile: SIFT_QUERY_FILE,
        groundTruthFile: SIFT_GT_FILE,
        insertLimit: SIFT_LIMIT,
        resultFile: 'recall_sift1m.json',
        source: 'http://corpus-texmex.irisa.fr/',
      });
    },
    12 * 60 * 60 * 1000,
  );

  it(
    'measures GIST1M recall through HNSWIndex',
    async () => {
      await runTexmexRecallBenchmark({
        datasetLabel: 'GIST1M',
        baseFile: GIST_BASE_FILE,
        queryFile: GIST_QUERY_FILE,
        groundTruthFile: GIST_GT_FILE,
        insertLimit: GIST_LIMIT,
        resultFile: 'recall_gist1m.json',
        source: 'http://corpus-texmex.irisa.fr/',
      });
    },
    12 * 60 * 60 * 1000,
  );

  it(
    'measures random 1M 128D recall through HNSWIndex',
    async () => {
      await runRandomRecallBenchmark();
    },
    12 * 60 * 60 * 1000,
  );
});
