/**
 * DBMS insert overhead benchmark
 *
 * Compares document insert time vs database size for two configurations:
 *   1. B+ tree index only  (no semantic / HNSW index)
 *   2. B+ tree + HNSW index  (mock random-vector encoder, 384-dim)
 *
 * A mock encoder is used so the measured overhead is purely structural
 * (HNSW graph maintenance, I/O, etc.) — independent of any model inference
 * time.  See the embedding_speed benchmark for real encoding latencies to
 * add on top.
 *
 * Both series are plotted on the same graph so you can see the overhead of
 * maintaining the HNSW index alongside the B+ tree.
 *
 * Environment variables (all optional):
 *   DBMS_INSERT_COUNT          Maximum documents to insert per series  (default 1 000 000)
 *   DBMS_BLOCK_SIZE            FreeBlockFile block size in bytes        (default 4096)
 *   DBMS_COMMIT_INTERVAL       Commit every N inserts                   (default 500)
 *   DBMS_CHECKPOINT_INTERVAL   Record a data point every N inserts      (default 10 000)
 *   DBMS_KEEP_DB               Keep database files after the run        (default false)
 *   DBMS_HNSW_M                HNSW M parameter                        (default 16)
 *   DBMS_HNSW_EF_CONSTRUCTION  HNSW efConstruction parameter           (default 200)
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { RealFile } from '../../src/storage/file.mjs';
import { SimpleDbms, type HnswConfig } from '../../src/database/simpledbms.mjs';
import { MOCK_HNSW_DIMENSION, MOCK_HNSW_ENCODER_LABEL, mockEmbed } from './mock_encoder.mjs';

// ---------------------------------------------------------------------------
// Configuration
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

const INSERT_COUNT = envNumber('DBMS_INSERT_COUNT', 1_000_000);
const BLOCK_SIZE = envNumber('DBMS_BLOCK_SIZE', 4096);
const COMMIT_INTERVAL = envNumber('DBMS_COMMIT_INTERVAL', 500);
const CHECKPOINT_INTERVAL = envNumber('DBMS_CHECKPOINT_INTERVAL', 1_000);
const KEEP_DB_FILES = envBoolean('DBMS_KEEP_DB', false);
const HNSW_M = envNumber('DBMS_HNSW_M', 16);
const HNSW_EF_CONSTRUCTION = envNumber('DBMS_HNSW_EF_CONSTRUCTION', 200);

const HNSW_DIMENSION = MOCK_HNSW_DIMENSION;
const COLLECTION = 'docs';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const BASE_DIR = join('benchmarks', 'dbms');
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

function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, '0')}m ${seconds.toString().padStart(2, '0')}s`;
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  return `${seconds}s`;
}

function renderProgress(label: string, done: number, total: number, startedAt: number, extra: string): string {
  const elapsedMs = performance.now() - startedAt;
  const pct = ((done / total) * 100).toFixed(1).padStart(5);
  const rate = elapsedMs > 0 ? done / (elapsedMs / 1000) : 0;
  const remainingMs = rate > 0 && total > done ? ((total - done) / rate) * 1000 : 0;
  return (
    `[${label}] ${pct}%  ${done.toLocaleString()} / ${total.toLocaleString()}  ` +
    `elapsed=${formatDurationMs(elapsedMs)}  eta=${formatDurationMs(remainingMs)}  ${extra}`
  );
}

type Checkpoint = {
  indexSize: number;
  insertMeanMs: number;
  elapsedMs: number;
};

// ---------------------------------------------------------------------------
// Core measurement loop (shared by both series)
// ---------------------------------------------------------------------------

async function runInsertSeries(
  label: string,
  db: SimpleDbms,
  insertCount: number,
  /**
   * Called with the 0-based insert index and the document key to generate
   * the JSON document string to insert.
   */
  makeDocument: (idx: number, docKey: string) => string,
): Promise<Checkpoint[]> {
  const checkpoints: Checkpoint[] = [];
  const startedAt = performance.now();
  let windowInsertMs = 0;
  let windowInsertCount = 0;

  for (let ordinal = 0; ordinal < insertCount; ordinal++) {
    const insertOrdinal = ordinal + 1;
    const docKey = `doc:${ordinal}`;
    const doc = makeDocument(ordinal, docKey);

    const insertStart = performance.now();
    await db.insertDocument(COLLECTION, doc);
    const insertMs = performance.now() - insertStart;

    windowInsertMs += insertMs;
    windowInsertCount += 1;

    if (insertOrdinal % COMMIT_INTERVAL === 0) {
      await db.commit();
    }

    const isCheckpoint = insertOrdinal % CHECKPOINT_INTERVAL === 0 || insertOrdinal === insertCount;
    if (!isCheckpoint) continue;

    if (insertOrdinal % COMMIT_INTERVAL !== 0) {
      await db.commit();
    }

    const insertMeanMs = windowInsertMs / windowInsertCount;

    checkpoints.push({
      indexSize: insertOrdinal,
      insertMeanMs,
      elapsedMs: performance.now() - startedAt,
    });

    process.stdout.write(
      renderProgress(label, insertOrdinal, insertCount, startedAt, `insert=${insertMeanMs.toFixed(3)}ms\n`),
    );

    windowInsertMs = 0;
    windowInsertCount = 0;
  }

  await db.commit();
  return checkpoints;
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

describe('DBMS insert overhead: B+tree-only vs B+tree+HNSW', () => {
  it(
    'compares insert time vs database size for both index configurations',
    async () => {
      ensureDirs();

      // ------------------------------------------------------------------
      // Series 1: B+ tree index only (no HNSW)
      // ------------------------------------------------------------------

      process.stdout.write('\n--- Series 1/2: B+ tree only (no HNSW index) ---\n');

      const btreeRunDir = join(DB_DIR, 'btree_only');
      rmSync(btreeRunDir, { recursive: true, force: true });
      mkdirSync(btreeRunDir, { recursive: true });

      const btreeDataFile = new RealFile(join(btreeRunDir, 'db.data'));
      const btreeLogFile = new RealFile(join(btreeRunDir, 'db.log'));

      const btreeDb = await SimpleDbms.create(btreeDataFile, btreeLogFile);
      let btreeCheckpoints: Checkpoint[];
      try {
        btreeCheckpoints = await runInsertSeries('btree-only', btreeDb, INSERT_COUNT, (idx, docKey) =>
          JSON.stringify({ id: docKey, title: `Document ${idx}`, body: `Body of document number ${idx}` }),
        );
      } finally {
        await btreeDb.close();
        if (!KEEP_DB_FILES) {
          rmSync(btreeRunDir, { recursive: true, force: true });
        }
      }

      // ------------------------------------------------------------------
      // Series 2: B+ tree + HNSW index (mock random-vector encoder)
      // ------------------------------------------------------------------

      process.stdout.write('\n--- Series 2/2: B+ tree + HNSW index (mock encoder, 384-dim random vectors) ---\n');
      process.stdout.write('Using mock encoder — measures pure HNSW structural overhead without model inference.\n');

      const hnswConfig: HnswConfig = {
        dimension: HNSW_DIMENSION,
        M: HNSW_M,
        efConstruction: HNSW_EF_CONSTRUCTION,
        embeddingFn: (text: string) => Promise.resolve(mockEmbed(text)),
      };

      const hnswRunDir = join(DB_DIR, 'btree_hnsw');
      rmSync(hnswRunDir, { recursive: true, force: true });
      mkdirSync(hnswRunDir, { recursive: true });

      const hnswDataFile = new RealFile(join(hnswRunDir, 'db.data'));
      const hnswLogFile = new RealFile(join(hnswRunDir, 'db.log'));

      const hnswDb = await SimpleDbms.create(hnswDataFile, hnswLogFile, hnswConfig);
      let hnswCheckpoints: Checkpoint[];
      try {
        hnswCheckpoints = await runInsertSeries('btree+hnsw', hnswDb, INSERT_COUNT, (idx, docKey) =>
          JSON.stringify({ id: docKey, title: `Document ${idx}`, body: `Body of document number ${idx}` }),
        );
      } finally {
        await hnswDb.close();
        if (!KEEP_DB_FILES) {
          rmSync(hnswRunDir, { recursive: true, force: true });
        }
      }

      // ------------------------------------------------------------------
      // Save results
      // ------------------------------------------------------------------

      const resultPath = join(RESULTS_DIR, 'insert_overhead.json');
      writeFileSync(
        resultPath,
        JSON.stringify(
          {
            meta: {
              insertCount: INSERT_COUNT,
              blockSize: BLOCK_SIZE,
              commitInterval: COMMIT_INTERVAL,
              checkpointInterval: CHECKPOINT_INTERVAL,
              hnswEncoder: MOCK_HNSW_ENCODER_LABEL,
              hnswDimension: HNSW_DIMENSION,
              hnswM: HNSW_M,
              hnswEfConstruction: HNSW_EF_CONSTRUCTION,
            },
            btreeOnly: btreeCheckpoints,
            btreeHnsw: hnswCheckpoints,
          },
          null,
          2,
        ),
      );

      process.stdout.write(`\nSaved insert overhead results to ${resultPath}\n`);
    },
    24 * 60 * 60 * 1000, // 24 hour timeout
  );
});
