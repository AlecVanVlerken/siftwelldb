import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { RealFile, type File } from '../../src/storage/file.mjs';
import { SimpleDbms, type HnswConfig } from '../../src/database/simpledbms.mjs';
import {
  cleanupStorage,
  createStorageDescriptor,
  type StorageDescriptor,
  envBoolean,
  envNumber,
  envString,
  mean,
  percentile,
  renderProgressLine,
  resolveStorageMode,
  writeJsonResult,
} from './common.mjs';
import { inspectFvecs, loadFvecs, streamFvecs } from './texmex.mjs';

const DATASET_DIR = envString('HNSW_SIFT_DIR', join('benchmarks', 'hnsw', 'datasets', 'sift'));
const BASE_FILE = join(DATASET_DIR, envString('HNSW_SIFT_BASE_FILE', 'sift_base.fvecs'));
const QUERY_FILE = join(DATASET_DIR, envString('HNSW_SIFT_QUERY_FILE', 'sift_query.fvecs'));

const BLOCK_SIZE = envNumber('HNSW_BLOCK_SIZE', 4096);
const MAX_STORED_LEVEL = envNumber('HNSW_MAX_STORED_LEVEL', 6);
const M = envNumber('HNSW_M', 16);
const EF_CONSTRUCTION = envNumber('HNSW_EF_CONSTRUCTION', 200);
const EF_SEARCH = envNumber('HNSW_EF_SEARCH', 128);
const K = envNumber('HNSW_K', 10);
const COMMIT_INTERVAL = envNumber('HNSW_COMMIT_INTERVAL', 500);
const CHECKPOINT_INTERVAL = envNumber('HNSW_SIMPLEDBMS_COMPLEXITY_CHECKPOINT_INTERVAL', 10_000);
const SEARCH_QUERY_COUNT = envNumber('HNSW_SIMPLEDBMS_COMPLEXITY_QUERY_COUNT', 200);
const INSERT_LIMIT = envNumber('HNSW_SIFT_LIMIT', 1_000_000);
const KEEP_DB_FILES = envBoolean('HNSW_KEEP_DB', false);
const STORAGE_MODE = resolveStorageMode('real');
const COLLECTION = envString('HNSW_SIMPLEDBMS_COLLECTION', 'sift');

function requireSiftFiles(): void {
  const missing = [BASE_FILE, QUERY_FILE].filter((filePath) => !existsSync(filePath));
  if (missing.length === 0) return;
  throw new Error(
    `SIFT benchmark dataset is missing. Expected files under ${DATASET_DIR}.\n` +
      `Missing:\n${missing.map((filePath) => `  - ${filePath}`).join('\n')}\n\n` +
      `Download and extract the Texmex SIFT1M dataset into ${DATASET_DIR}.`,
  );
}

function createDbmsFiles(descriptor: StorageDescriptor): { dataFile: File; logFile: File } {
  if (descriptor.mode === 'real') {
    return {
      dataFile: new RealFile(descriptor.dataPath),
      logFile: new RealFile(descriptor.logPath),
    };
  }

  return {
    dataFile: descriptor.dataFile,
    logFile: descriptor.logFile,
  };
}

describe('SimpleDbms complexity benchmark', () => {
  it(
    'measures SIFT1M insert and search complexity through SimpleDbms',
    async () => {
      requireSiftFiles();

      const baseInfo = await inspectFvecs(BASE_FILE);
      const insertCount = Math.min(INSERT_LIMIT, baseInfo.count);
      const queries = await loadFvecs(QUERY_FILE, SEARCH_QUERY_COUNT);

      if (queries.dim !== baseInfo.dim) {
        throw new Error(`Dimension mismatch between SIFT base (${baseInfo.dim}) and queries (${queries.dim}).`);
      }

      const descriptor = createStorageDescriptor(
        'complexity_simpledbms_sift1m',
        STORAGE_MODE,
        BLOCK_SIZE,
        KEEP_DB_FILES,
      );
      const { dataFile, logFile } = createDbmsFiles(descriptor);

      const queryVectorMap = new Map<string, Float32Array>();
      const queryKeys: string[] = [];
      for (let queryIndex = 0; queryIndex < queries.count; queryIndex++) {
        const queryKey = `query:${queryIndex}`;
        queryKeys.push(queryKey);
        queryVectorMap.set(
          queryKey,
          Float32Array.from(queries.data.subarray(queryIndex * queries.dim, (queryIndex + 1) * queries.dim)),
        );
      }

      let pendingDocKey: string | null = null;
      let pendingDocVector: Float32Array | null = null;

      const hnswConfig: HnswConfig = {
        dimension: baseInfo.dim,
        M,
        efConstruction: EF_CONSTRUCTION,
        efSearch: EF_SEARCH,
        maxStoredLevel: MAX_STORED_LEVEL,
        embeddingFn: (text: string) => {
          const vector = queryVectorMap.get(text);
          if (vector !== undefined) return Promise.resolve(vector);
          if (text === pendingDocKey && pendingDocVector !== null) return Promise.resolve(pendingDocVector);
          return Promise.reject(new Error(`No benchmark embedding available for key: ${text}`));
        },
      };

      const db = await SimpleDbms.create(dataFile, logFile, hnswConfig);

      const checkpoints: Array<{
        indexSize: number;
        insertMeanMs: number;
        searchMeanMs: number;
        searchP50Ms: number;
        searchP95Ms: number;
        elapsedMs: number;
      }> = [];

      const startedAt = performance.now();
      let totalInsertMs = 0;
      let windowInsertMs = 0;
      let windowInsertCount = 0;

      try {
        await streamFvecs(
          BASE_FILE,
          async (vector, indexOffset) => {
            const insertOrdinal = indexOffset + 1;
            const docKey = `doc:${indexOffset}`;
            pendingDocKey = docKey;
            pendingDocVector = Float32Array.from(vector);

            const insertStartedAt = performance.now();
            await db.insertDocument(COLLECTION, JSON.stringify({ id: docKey, text: docKey }));
            const insertMs = performance.now() - insertStartedAt;

            totalInsertMs += insertMs;
            windowInsertMs += insertMs;
            windowInsertCount += 1;

            pendingDocKey = null;
            pendingDocVector = null;

            if (insertOrdinal % COMMIT_INTERVAL === 0) {
              await db.commit();
            }

            const isCheckpoint = insertOrdinal % CHECKPOINT_INTERVAL === 0 || insertOrdinal === insertCount;
            if (!isCheckpoint) return;

            if (insertOrdinal % COMMIT_INTERVAL !== 0) {
              await db.commit();
            }

            const searchTimes: number[] = [];
            for (const queryKey of queryKeys) {
              const searchStartedAt = performance.now();
              await db.semanticSearch(COLLECTION, queryKey, K);
              searchTimes.push(performance.now() - searchStartedAt);
            }

            const sortedSearchTimes = searchTimes.slice().sort((left, right) => left - right);
            const insertMeanMs = windowInsertMs / windowInsertCount;
            const searchMeanMs = mean(searchTimes);

            checkpoints.push({
              indexSize: insertOrdinal,
              insertMeanMs,
              searchMeanMs,
              searchP50Ms: percentile(sortedSearchTimes, 50),
              searchP95Ms: percentile(sortedSearchTimes, 95),
              elapsedMs: performance.now() - startedAt,
            });

            process.stdout.write(
              renderProgressLine(
                'simpledbms-complexity',
                insertOrdinal,
                insertCount,
                startedAt,
                `insert=${insertMeanMs.toFixed(3)}ms  search=${searchMeanMs.toFixed(3)}ms\n`,
              ),
            );

            windowInsertMs = 0;
            windowInsertCount = 0;
          },
          { limit: insertCount },
        );

        await db.commit();

        const resultPath = writeJsonResult('complexity_simpledbms_sift1m.json', {
          meta: {
            system: 'SimpleDbms',
            dataset: 'SIFT1M',
            collection: COLLECTION,
            storageMode: STORAGE_MODE,
            blockSize: BLOCK_SIZE,
            maxStoredLevel: MAX_STORED_LEVEL,
            M,
            efConstruction: EF_CONSTRUCTION,
            efSearch: EF_SEARCH,
            K,
            commitInterval: COMMIT_INTERVAL,
            checkpointInterval: CHECKPOINT_INTERVAL,
            insertCount,
            queryCount: queries.count,
            dimension: baseInfo.dim,
            totalInsertMs,
          },
          checkpoints,
        });

        process.stdout.write(`Saved SimpleDbms complexity results to ${resultPath}\n`);
      } finally {
        await db.close();
        cleanupStorage(descriptor);
      }
    },
    12 * 60 * 60 * 1000,
  );
});
