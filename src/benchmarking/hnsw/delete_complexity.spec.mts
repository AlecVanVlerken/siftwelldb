import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import {
  cleanupStorage,
  createBenchmarkIndex,
  envBoolean,
  envNumber,
  envString,
  renderProgressLine,
  resolveStorageMode,
  writeJsonResult,
} from './common.mjs';
import { inspectFvecs, streamFvecs } from './texmex.mjs';

const DATASET_DIR = envString('HNSW_SIFT_DIR', join('src', 'benchmarking', 'hnsw', 'datasets', 'sift'));
const BASE_FILE = join(DATASET_DIR, envString('HNSW_SIFT_BASE_FILE', 'sift_base.fvecs'));

const BLOCK_SIZE = envNumber('HNSW_BLOCK_SIZE', 4096);
const MAX_STORED_LEVEL = envNumber('HNSW_MAX_STORED_LEVEL', 6);
const M = envNumber('HNSW_M', 16);
const EF_CONSTRUCTION = envNumber('HNSW_EF_CONSTRUCTION', 200);
const EF_SEARCH = envNumber('HNSW_EF_SEARCH', 128);
const BUILD_COMMIT_INTERVAL = Math.max(1, envNumber('HNSW_COMMIT_INTERVAL', 500));
const DELETE_COMMIT_INTERVAL = Math.max(1, envNumber('HNSW_DELETE_COMMIT_INTERVAL', 10));
const CHECKPOINT_INTERVAL = Math.max(1, envNumber('HNSW_DELETE_CHECKPOINT_INTERVAL', 100));
const DELETE_LIMIT = Math.max(
  1,
  envNumber('HNSW_DELETE_LIMIT', Math.min(envNumber('HNSW_SIFT_LIMIT', 100_000), 100_000)),
);
const KEEP_DB_FILES = envBoolean('HNSW_KEEP_DB', false);
const STORAGE_MODE = resolveStorageMode('real');
const DELETE_ORDER = 'reverse';

function requireSiftBaseFile(): void {
  if (existsSync(BASE_FILE)) return;
  throw new Error(
    `SIFT benchmark dataset is missing. Expected base file under ${DATASET_DIR}.\n` +
      `Missing:\n  - ${BASE_FILE}\n\n` +
      `Download and extract the Texmex SIFT1M dataset into ${DATASET_DIR}.`,
  );
}

describe('HNSWIndex deletion complexity benchmark', () => {
  it(
    'measures checkpointed delete cost on a capped SIFT build through HNSWIndex',
    async () => {
      requireSiftBaseFile();

      const baseInfo = await inspectFvecs(BASE_FILE);
      const insertCount = Math.min(DELETE_LIMIT, baseInfo.count);

      const { descriptor, graphStorage, index } = await createBenchmarkIndex({
        label: 'delete_complexity_sift1m',
        dimension: baseInfo.dim,
        blockSize: BLOCK_SIZE,
        maxStoredLevel: MAX_STORED_LEVEL,
        keepFiles: KEEP_DB_FILES,
        storageMode: STORAGE_MODE,
        params: {
          M,
          efConstruction: EF_CONSTRUCTION,
          efSearch: EF_SEARCH,
        },
      });

      const checkpoints: Array<{
        deletedCount: number;
        liveSizeMean: number;
        remainingSize: number;
        deleteMeanMs: number;
        pureDeleteElapsedMs: number;
        wallElapsedMs: number;
      }> = [];

      const buildStartedAt = performance.now();
      let buildInsertMs = 0;

      let deleteStartedAt = 0;
      let totalDeleteMs = 0;
      let windowDeleteMs = 0;
      let windowDeleteCount = 0;
      let windowLiveSizeTotal = 0;

      try {
        await streamFvecs(
          BASE_FILE,
          async (vector, indexOffset) => {
            const insertOrdinal = indexOffset + 1;
            const insertStartedAt = performance.now();
            await index.insert(indexOffset, vector);
            buildInsertMs += performance.now() - insertStartedAt;

            if (insertOrdinal % BUILD_COMMIT_INTERVAL === 0) {
              await index.commit();
            }

            const shouldLog =
              insertOrdinal === insertCount ||
              (insertOrdinal <= 50_000 ? insertOrdinal % 10_000 === 0 : insertOrdinal % 50_000 === 0);

            if (!shouldLog) return;

            process.stdout.write(
              renderProgressLine(
                'delete-build',
                insertOrdinal,
                insertCount,
                buildStartedAt,
                `insert=${(buildInsertMs / insertOrdinal).toFixed(3)}ms\n`,
              ),
            );
          },
          { limit: insertCount },
        );

        if (insertCount % BUILD_COMMIT_INTERVAL !== 0) {
          await index.commit();
        }

        const buildWallMs = performance.now() - buildStartedAt;
        deleteStartedAt = performance.now();

        for (let deleteOffset = 0; deleteOffset < insertCount; deleteOffset++) {
          const deleteOrdinal = deleteOffset + 1;
          const liveSizeBeforeDelete = insertCount - deleteOffset;
          const docId = insertCount - deleteOrdinal;

          const deleteOperationStartedAt = performance.now();
          await index.delete(docId);
          const deleteMs = performance.now() - deleteOperationStartedAt;

          totalDeleteMs += deleteMs;
          windowDeleteMs += deleteMs;
          windowDeleteCount += 1;
          windowLiveSizeTotal += liveSizeBeforeDelete;

          if (deleteOrdinal % DELETE_COMMIT_INTERVAL === 0) {
            await index.commit();
          }

          const isCheckpoint = deleteOrdinal % CHECKPOINT_INTERVAL === 0 || deleteOrdinal === insertCount;
          if (!isCheckpoint) continue;

          if (deleteOrdinal % DELETE_COMMIT_INTERVAL !== 0) {
            await index.commit();
          }

          const deleteMeanMs = windowDeleteMs / windowDeleteCount;
          const liveSizeMean = windowLiveSizeTotal / windowDeleteCount;
          const remainingSize = liveSizeBeforeDelete - 1;

          checkpoints.push({
            deletedCount: deleteOrdinal,
            liveSizeMean,
            remainingSize,
            deleteMeanMs,
            pureDeleteElapsedMs: totalDeleteMs,
            wallElapsedMs: performance.now() - deleteStartedAt,
          });

          process.stdout.write(
            renderProgressLine(
              'delete-complexity',
              deleteOrdinal,
              insertCount,
              deleteStartedAt,
              `live≈${liveSizeMean.toFixed(1)}  delete=${deleteMeanMs.toFixed(3)}ms\n`,
            ),
          );

          windowDeleteMs = 0;
          windowDeleteCount = 0;
          windowLiveSizeTotal = 0;
        }

        await index.commit();

        const resultPath = writeJsonResult('delete_complexity_sift1m.json', {
          meta: {
            dataset: 'SIFT1M',
            dimension: baseInfo.dim,
            insertCount,
            deleteOrder: DELETE_ORDER,
            storageMode: STORAGE_MODE,
            blockSize: BLOCK_SIZE,
            maxStoredLevel: MAX_STORED_LEVEL,
            M,
            efConstruction: EF_CONSTRUCTION,
            efSearch: EF_SEARCH,
            buildCommitInterval: BUILD_COMMIT_INTERVAL,
            deleteCommitInterval: DELETE_COMMIT_INTERVAL,
            checkpointInterval: CHECKPOINT_INTERVAL,
            buildTotalInsertMs: buildInsertMs,
            buildWallMs,
            totalDeleteMs,
            metaBlockId: graphStorage.metaBlockId,
          },
          checkpoints,
        });

        process.stdout.write(`Saved deletion complexity results to ${resultPath}\n`);
      } finally {
        await index.close();
        cleanupStorage(descriptor);
      }
    },
    12 * 60 * 60 * 1000,
  );
});
