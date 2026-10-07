import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { HNSWGraphStorage } from '../../src/indexes/hnsw/hnswGraphStorage.mjs';
import { HNSWIndex } from '../../src/indexes/hnsw/hnswIndex.mjs';
import { VectorHeapFile } from '../../src/indexes/hnsw/vectorHeapFile.mjs';
import {
  cleanupStorage,
  createFreeBlockFile,
  createStorageDescriptor,
  envBoolean,
  envNumber,
  envString,
  renderProgressLine,
  resolveStorageMode,
  writeJsonResult,
} from './common.mjs';
import { LegacyTsHNSWIndex } from './legacyTsHnswIndex.mjs';
import { inspectFvecs, loadFvecs, type LoadedFvecs } from './texmex.mjs';

const LEGACY_BASE_COMMIT = '425b486';

const DATASET_DIR = envString('HNSW_SIFT_DIR', join('benchmarks', 'hnsw', 'datasets', 'sift'));
const BASE_FILE = join(DATASET_DIR, envString('HNSW_SIFT_BASE_FILE', 'sift_base.fvecs'));

const BLOCK_SIZE = envNumber('HNSW_BLOCK_SIZE', 4096);
const MAX_STORED_LEVEL = envNumber('HNSW_MAX_STORED_LEVEL', 6);
const M = envNumber('HNSW_M', 16);
const EF_CONSTRUCTION = envNumber('HNSW_EF_CONSTRUCTION', 200);
const EF_SEARCH = envNumber('HNSW_EF_SEARCH', 128);
const CHECKPOINT_INTERVAL = envNumber('HNSW_COMPARE_CHECKPOINT_INTERVAL', 1_000);
const INSERT_LIMIT = envNumber('HNSW_COMPARE_INSERT_LIMIT', 1_000_000);
const KEEP_DB_FILES = envBoolean('HNSW_KEEP_DB', false);
const STORAGE_MODE = resolveStorageMode('real');

type InsertCheckpoint = {
  indexSize: number;
  insertMeanMs: number;
  elapsedMs: number;
};

type InsertRunResult = {
  implementation: 'rust' | 'legacy-typescript';
  label: string;
  totalInsertMs: number;
  totalWallMs: number;
  checkpoints: InsertCheckpoint[];
};

type InsertBenchmarkIndex = {
  insert(docId: number, vector: Float32Array): Promise<void>;
  commit(): Promise<void>;
  close(): Promise<void>;
};

function requireSiftBaseFile(): void {
  if (existsSync(BASE_FILE)) return;
  throw new Error(
    `SIFT benchmark dataset is missing. Expected base file under ${DATASET_DIR}.\n` +
      `Missing:\n  - ${BASE_FILE}\n\n` +
      `Download and extract the Texmex SIFT1M dataset into ${DATASET_DIR}.`,
  );
}

async function createInsertBenchmarkIndex(
  implementation: InsertRunResult['implementation'],
  label: string,
  dimension: number,
): Promise<{
  descriptor: ReturnType<typeof createStorageDescriptor>;
  index: InsertBenchmarkIndex;
}> {
  const descriptor = createStorageDescriptor(label, STORAGE_MODE, BLOCK_SIZE, KEEP_DB_FILES);
  const file = await createFreeBlockFile(descriptor);
  const graphStorage = await HNSWGraphStorage.create(file, M, MAX_STORED_LEVEL);
  const vectorHeap = new VectorHeapFile(file, dimension);

  const index =
    implementation === 'rust'
      ? HNSWIndex.create(graphStorage, vectorHeap, {
          M,
          efConstruction: EF_CONSTRUCTION,
          efSearch: EF_SEARCH,
        })
      : LegacyTsHNSWIndex.create(graphStorage, vectorHeap, {
          M,
          efConstruction: EF_CONSTRUCTION,
          efSearch: EF_SEARCH,
        });

  return { descriptor, index };
}

async function runInsertBenchmark(args: {
  implementation: InsertRunResult['implementation'];
  label: string;
  vectors: LoadedFvecs;
}): Promise<InsertRunResult> {
  const { descriptor, index } = await createInsertBenchmarkIndex(args.implementation, args.label, args.vectors.dim);
  const checkpoints: InsertCheckpoint[] = [];
  const startedAt = performance.now();
  let totalInsertMs = 0;
  let windowInsertMs = 0;
  let windowInsertCount = 0;

  process.stdout.write(`Starting ${args.label} insert benchmark...\n`);

  try {
    for (let indexOffset = 0; indexOffset < args.vectors.count; indexOffset++) {
      const insertOrdinal = indexOffset + 1;
      const vector = args.vectors.data.subarray(indexOffset * args.vectors.dim, insertOrdinal * args.vectors.dim);

      const insertStartedAt = performance.now();
      await index.insert(indexOffset, vector);
      const insertMs = performance.now() - insertStartedAt;

      totalInsertMs += insertMs;
      windowInsertMs += insertMs;
      windowInsertCount += 1;

      const isCheckpoint = insertOrdinal % CHECKPOINT_INTERVAL === 0 || insertOrdinal === args.vectors.count;
      if (!isCheckpoint) continue;

      const insertMeanMs = windowInsertMs / windowInsertCount;
      checkpoints.push({
        indexSize: insertOrdinal,
        insertMeanMs,
        elapsedMs: performance.now() - startedAt,
      });

      process.stdout.write(
        renderProgressLine(
          args.label,
          insertOrdinal,
          args.vectors.count,
          startedAt,
          `insert=${insertMeanMs.toFixed(3)}ms\n`,
        ),
      );

      windowInsertMs = 0;
      windowInsertCount = 0;
    }

    await index.commit();

    return {
      implementation: args.implementation,
      label: args.label,
      totalInsertMs,
      totalWallMs: performance.now() - startedAt,
      checkpoints,
    };
  } finally {
    await index.close();
    cleanupStorage(descriptor);
  }
}

describe('Rust vs legacy TypeScript HNSW insert benchmark', () => {
  it(
    'compares insert time on the first 1M SIFT vectors by default',
    async () => {
      requireSiftBaseFile();

      const baseInfo = await inspectFvecs(BASE_FILE);
      const insertCount = Math.min(INSERT_LIMIT, baseInfo.count);
      const vectors = await loadFvecs(BASE_FILE, insertCount);

      const runs: InsertRunResult[] = [];
      runs.push(
        await runInsertBenchmark({
          implementation: 'rust',
          label: 'insert-compare rust',
          vectors,
        }),
      );
      runs.push(
        await runInsertBenchmark({
          implementation: 'legacy-typescript',
          label: 'insert-compare legacy-ts',
          vectors,
        }),
      );

      const resultPath = writeJsonResult('insert_compare_sift.json', {
        meta: {
          dataset: 'SIFT1M',
          dimension: vectors.dim,
          insertCount: vectors.count,
          blockSize: BLOCK_SIZE,
          storageMode: STORAGE_MODE,
          maxStoredLevel: MAX_STORED_LEVEL,
          M,
          efConstruction: EF_CONSTRUCTION,
          efSearch: EF_SEARCH,
          checkpointInterval: CHECKPOINT_INTERVAL,
          legacyBaseCommit: LEGACY_BASE_COMMIT,
        },
        runs,
      });

      const rustRun = runs.find((run) => run.implementation === 'rust');
      const legacyRun = runs.find((run) => run.implementation === 'legacy-typescript');
      if (rustRun && legacyRun) {
        const rustMeanMs = rustRun.totalInsertMs / vectors.count;
        const legacyMeanMs = legacyRun.totalInsertMs / vectors.count;
        const speedup = rustMeanMs > 0 ? legacyMeanMs / rustMeanMs : 0;
        process.stdout.write(
          `Rust mean insert=${rustMeanMs.toFixed(3)}ms  ` +
            `Rust pure insert=${(rustRun.totalInsertMs / 1000).toFixed(2)}s  ` +
            `Rust wall=${(rustRun.totalWallMs / 1000).toFixed(2)}s  ` +
            `Legacy TS mean insert=${legacyMeanMs.toFixed(3)}ms  ` +
            `Legacy TS pure insert=${(legacyRun.totalInsertMs / 1000).toFixed(2)}s  ` +
            `Legacy TS wall=${(legacyRun.totalWallMs / 1000).toFixed(2)}s  ` +
            `speedup=${speedup.toFixed(2)}x\n`,
        );
      }

      process.stdout.write(`Saved insert comparison results to ${resultPath}\n`);
    },
    12 * 60 * 60 * 1000,
  );
});
