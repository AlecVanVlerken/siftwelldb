import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { AtomicFile } from '../../atomic/atomicfile.mjs';
import { RealFile } from '../../core/file.mjs';
import { FreeBlockFile } from '../../freeblockfile/freeblockfile.mjs';
import { BPlusTree } from '../../btree/btree.mjs';
import { BlockNodeStorage } from '../../btree/nodestorage.mjs';

// ---------------------------------------------------------------------------
// Configuration (all overridable via environment variables)
// ---------------------------------------------------------------------------

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be numeric, got ${raw}`);
  return value;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${name} must be boolean-like, got ${raw}`);
}

const INSERT_COUNT = envNumber('BTREE_INSERT_COUNT', 12_000_000);
const BLOCK_SIZE = envNumber('BTREE_BLOCK_SIZE', 4096);
const COMMIT_INTERVAL = envNumber('BTREE_COMMIT_INTERVAL', 1_000);
const CHECKPOINT_INTERVAL = envNumber('BTREE_CHECKPOINT_INTERVAL', 10_000);
const SEARCH_QUERY_COUNT = envNumber('BTREE_SEARCH_QUERY_COUNT', 200);
const RANDOM_SEED = envNumber('BTREE_RANDOM_SEED', 0x1a2b3c4d);
const KEEP_DB_FILES = envBoolean('BTREE_KEEP_DB', false);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const BASE_DIR = join('src', 'benchmarking', 'btree');
const RESULTS_DIR = join(BASE_DIR, 'results');
const IMAGES_DIR = join(RESULTS_DIR, 'images');
const DB_DIR = join(RESULTS_DIR, 'db');

function ensureDirs(): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  mkdirSync(IMAGES_DIR, { recursive: true });
  mkdirSync(DB_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a 64-bit integer as an 8-byte big-endian buffer (lexicographic sort). */
function makeKey(i: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(i));
  return buf;
}

function makeValue(i: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(i));
  return buf;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(Math.max(Math.ceil((p / 100) * sorted.length) - 1, 0), sorted.length - 1);
  return sorted[idx];
}

function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, '0')}m ${seconds.toString().padStart(2, '0')}s`;
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, '00')}s`;
  return `${seconds}s`;
}

function renderProgress(done: number, total: number, startedAt: number, extra: string): string {
  const elapsedMs = performance.now() - startedAt;
  const pct = ((done / total) * 100).toFixed(1).padStart(5);
  const rate = elapsedMs > 0 ? done / (elapsedMs / 1000) : 0;
  const remainingMs = rate > 0 && total > done ? ((total - done) / rate) * 1000 : 0;
  return (
    `[btree-complexity] ${pct}%  ${done.toLocaleString()} / ${total.toLocaleString()}  ` +
    `elapsed=${formatDurationMs(elapsedMs)}  eta=${formatDurationMs(remainingMs)}  ${extra}`
  );
}

function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    [x, y] = [y, x % y];
  }
  return x;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) {
    state = 0x6d2b79f5;
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function createPermutationIndexGetter(size: number, seed: number): (ordinal: number) => number {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`INSERT_COUNT must be a non-negative safe integer, got ${size}`);
  }
  if (size <= 1) {
    return (ordinal) => ordinal;
  }

  const random = createSeededRandom(seed);
  const offset = Math.floor(random() * size);
  let step = Math.floor(random() * (size - 1)) + 1;
  while (greatestCommonDivisor(step, size) !== 1) {
    step += 1;
    if (step >= size) {
      step = 1;
    }
  }

  return (ordinal: number) => (offset + ordinal * step) % size;
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

describe('BPlusTree complexity benchmark', () => {
  it(
    'measures insert and search time vs database size',
    async () => {
      ensureDirs();

      const runDir = join(DB_DIR, 'complexity_btree');
      rmSync(runDir, { recursive: true, force: true });
      mkdirSync(runDir, { recursive: true });

      const dataFile = new RealFile(join(runDir, 'db.data'));
      const logFile = new RealFile(join(runDir, 'db.log'));
      const atomicFile = new AtomicFile(dataFile, logFile);
      const freeBlockFile = new FreeBlockFile(atomicFile, BLOCK_SIZE);
      await freeBlockFile.create();

      const storage = new BlockNodeStorage(freeBlockFile);
      const tree = await BPlusTree.create(storage);

      type Checkpoint = {
        indexSize: number;
        insertMeanMs: number;
        searchMeanMs: number;
        searchP50Ms: number;
        searchP95Ms: number;
        elapsedMs: number;
      };

      const checkpoints: Checkpoint[] = [];

      // Use an affine permutation over [0, INSERT_COUNT) so every key is visited
      // exactly once without materializing a 10 M-element shuffle array.
      const getInsertIndex = createPermutationIndexGetter(INSERT_COUNT, RANDOM_SEED);
      const random = createSeededRandom(RANDOM_SEED ^ 0xa5a5a5a5);
      const startedAt = performance.now();
      let windowInsertMs = 0;
      let windowInsertCount = 0;

      try {
        for (let ordinal = 0; ordinal < INSERT_COUNT; ordinal++) {
          const insertOrdinal = ordinal + 1;
          const keyIdx = getInsertIndex(ordinal);

          const key = makeKey(keyIdx);
          const value = makeValue(keyIdx);
          const insertStart = performance.now();
          await tree.insert(key, value);
          const insertMs = performance.now() - insertStart;

          windowInsertMs += insertMs;
          windowInsertCount += 1;

          if (insertOrdinal % COMMIT_INTERVAL === 0) {
            await freeBlockFile.commit();
          }

          const isCheckpoint = insertOrdinal % CHECKPOINT_INTERVAL === 0 || insertOrdinal === INSERT_COUNT;
          if (!isCheckpoint) continue;

          // Ensure the tree is committed before measuring search.
          if (insertOrdinal % COMMIT_INTERVAL !== 0) {
            await freeBlockFile.commit();
          }

          // Sample random previously inserted ordinals, then map them through the
          // same permutation so search queries stay within the inserted key set.
          const queryCount = Math.min(SEARCH_QUERY_COUNT, insertOrdinal);
          const searchTimes: number[] = [];
          for (let q = 0; q < queryCount; q++) {
            const queryOrdinal = Math.floor(random() * insertOrdinal);
            const queryKey = getInsertIndex(queryOrdinal);
            const searchStart = performance.now();
            await tree.get(makeKey(queryKey));
            searchTimes.push(performance.now() - searchStart);
          }

          const sortedSearchTimes = searchTimes.slice().sort((a, b) => a - b);
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
            renderProgress(
              insertOrdinal,
              INSERT_COUNT,
              startedAt,
              `insert=${insertMeanMs.toFixed(3)}ms  search=${searchMeanMs.toFixed(3)}ms\n`,
            ),
          );

          windowInsertMs = 0;
          windowInsertCount = 0;
        }

        await freeBlockFile.commit();

        const resultPath = join(RESULTS_DIR, 'complexity_btree.json');
        writeFileSync(
          resultPath,
          JSON.stringify(
            {
              meta: {
                system: 'BPlusTree',
                insertCount: INSERT_COUNT,
                blockSize: BLOCK_SIZE,
                commitInterval: COMMIT_INTERVAL,
                checkpointInterval: CHECKPOINT_INTERVAL,
                searchQueryCount: SEARCH_QUERY_COUNT,
                randomSeed: RANDOM_SEED,
                insertOrder: 'affine permutation',
                searchSampling: 'random prior ordinals',
              },
              checkpoints,
            },
            null,
            2,
          ),
        );

        process.stdout.write(`Saved BPlusTree complexity results to ${resultPath}\n`);
      } finally {
        await freeBlockFile.close();
        if (!KEEP_DB_FILES) {
          rmSync(runDir, { recursive: true, force: true });
        }
      }
    },
    12 * 60 * 60 * 1000, // 12 hour timeout
  );
});
