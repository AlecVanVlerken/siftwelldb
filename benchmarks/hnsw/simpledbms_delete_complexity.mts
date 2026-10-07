import { rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { RealFile } from '../../src/storage/file.mjs';
import { SimpleDbms, type HnswConfig } from '../../src/database/simpledbms.mjs';
import {
  DB_DIR,
  RESULTS_DIR,
  ensureBenchmarkDirs,
  envBoolean,
  envNumber,
  envNumberList,
  formatDurationMs,
  mean,
  percentile,
  renderProgressLine,
  writeJsonResult,
} from './common.mjs';

const COLLECTION = 'hnsw_delete_complexity';
const DEFAULT_SIZES = [100, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000];

const SIZES = envNumberList('HNSW_USER_DELETE_SIZES', DEFAULT_SIZES)
  .map((size) => Math.floor(size))
  .filter((size) => size > 1);
const DELETE_COUNT = Math.max(1, Math.floor(envNumber('HNSW_USER_DELETE_COUNT', 50)));
const BUILD_COMMIT_INTERVAL = Math.max(1, Math.floor(envNumber('HNSW_USER_DELETE_BUILD_COMMIT_INTERVAL', 5_000)));
const DIMENSION = Math.max(2, Math.floor(envNumber('HNSW_USER_DELETE_DIMENSION', 8)));
const M = Math.max(2, Math.floor(envNumber('HNSW_USER_DELETE_M', 8)));
const EF_CONSTRUCTION = Math.max(2, Math.floor(envNumber('HNSW_USER_DELETE_EF_CONSTRUCTION', 32)));
const EF_SEARCH = Math.max(2, Math.floor(envNumber('HNSW_USER_DELETE_EF_SEARCH', 128)));
const KEEP_DB_FILES = envBoolean('HNSW_USER_DELETE_KEEP_DB', false);

const CSV_FILE = join(RESULTS_DIR, 'simpledbms_delete_complexity.csv');
const JSON_FILE = 'simpledbms_delete_complexity.json';
const RUN_DB_DIR = join(DB_DIR, 'simpledbms_delete_complexity');

type DeleteSample = {
  id: string;
  deleteOnlyMs: number;
  commitMs: number;
  durableMs: number;
};

type BenchmarkRow = {
  collectionSize: number;
  deleteCount: number;
  avgDeleteMs: number;
  p50DeleteMs: number;
  p95DeleteMs: number;
  minDeleteMs: number;
  maxDeleteMs: number;
  avgDeleteDivLog2N: number;
  avgDeleteDivN: number;
  avgCommitMs: number;
  avgDurableDeleteMs: number;
  p50DurableDeleteMs: number;
  p95DurableDeleteMs: number;
  avgDurableDeleteDivLog2N: number;
  buildInsertWallMs: number;
  sanitySearchBeforeReopenMs: number;
  sanitySearchAfterReopenMs: number;
  logicalDeleteCheckMs: number;
};

function idFor(index: number): string {
  return `doc-${index}`;
}

function makeDocument(index: number): Record<string, string | number> {
  const id = idFor(index);
  return {
    id,
    title: id,
    body: `deterministic semantic delete benchmark payload ${id}`,
    group: `group-${index % 17}`,
    ordinal: index,
  };
}

function textSeed(text: string): number {
  const match = /doc-(\d+)/.exec(text);
  if (match) return Number(match[1]);

  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function deterministicEmbedding(text: string): Promise<Float32Array> {
  const seed = textSeed(text);
  const vector = new Float32Array(DIMENSION);

  // Keep the first axis monotonic in the document ordinal so a query for
  // "doc-N" has an exact same-vector match if that semantic entry is visible.
  vector[0] = seed / 100_000;
  for (let i = 1; i < DIMENSION; i += 1) {
    const value = (Math.imul(seed + 1, i * 1103515245 + 12345) >>> 0) % 10_000;
    vector[i] = value / 10_000;
  }
  return Promise.resolve(vector);
}

function hnswConfig(): HnswConfig {
  return {
    dimension: DIMENSION,
    embeddingFn: deterministicEmbedding,
    M,
    efConstruction: EF_CONSTRUCTION,
    efSearch: EF_SEARCH,
  };
}

function chooseDeleteIds(collectionSize: number, requestedDeleteCount: number): string[] {
  const actualCount = Math.min(requestedDeleteCount, collectionSize - 1);
  const chosen = new Set<number>();
  const step = collectionSize / (actualCount + 1);

  for (let i = 1; i <= actualCount; i += 1) {
    let candidate = Math.min(collectionSize - 1, Math.max(0, Math.floor(i * step)));
    while (chosen.has(candidate) && candidate < collectionSize - 1) candidate += 1;
    while (chosen.has(candidate) && candidate > 0) candidate -= 1;
    chosen.add(candidate);
  }

  return [...chosen].map(idFor);
}

async function expectDeletedDocumentsAreGone(db: SimpleDbms, deletedIds: readonly string[]): Promise<number> {
  const startedAt = performance.now();
  for (const deletedId of deletedIds) {
    try {
      await db.getDocumentById(COLLECTION, deletedId);
    } catch {
      continue;
    }
    throw new Error(`Deleted document ${deletedId} is still reachable through getDocumentById().`);
  }
  return performance.now() - startedAt;
}

async function expectSemanticSearchExcludes(
  db: SimpleDbms,
  deletedIds: readonly string[],
  collectionSize: number,
): Promise<number> {
  const startedAt = performance.now();
  const k = Math.min(100, Math.max(1, collectionSize - 1));
  for (const deletedId of deletedIds) {
    const results = await db.semanticSearch(COLLECTION, deletedId, k);
    const ids = results.map((json) => String((JSON.parse(json) as { id?: unknown }).id));
    if (ids.includes(deletedId)) {
      throw new Error(`Semantic search returned deleted document ${deletedId}. Results: ${ids.join(', ')}`);
    }
  }
  return performance.now() - startedAt;
}

function semanticSanityIds(deleteIds: readonly string[]): string[] {
  if (deleteIds.length <= 3) return [...deleteIds];
  return [...new Set([deleteIds[0], deleteIds[Math.floor(deleteIds.length / 2)], deleteIds[deleteIds.length - 1]])];
}

function sorted(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

function summarize(
  collectionSize: number,
  samples: readonly DeleteSample[],
  timing: Omit<BenchmarkRow, keyof ReturnType<typeof summarizeBase>>,
): BenchmarkRow {
  const base = summarizeBase(collectionSize, samples);
  return { ...base, ...timing };
}

function summarizeBase(collectionSize: number, samples: readonly DeleteSample[]) {
  const deleteTimes = sorted(samples.map((sample) => sample.deleteOnlyMs));
  const durableTimes = sorted(samples.map((sample) => sample.durableMs));
  const commitTimes = samples.map((sample) => sample.commitMs);
  const avgDeleteMs = mean(deleteTimes);
  const avgDurableDeleteMs = mean(durableTimes);
  const log2N = Math.log2(collectionSize);

  return {
    collectionSize,
    deleteCount: samples.length,
    avgDeleteMs,
    p50DeleteMs: percentile(deleteTimes, 50),
    p95DeleteMs: percentile(deleteTimes, 95),
    minDeleteMs: deleteTimes[0] ?? 0,
    maxDeleteMs: deleteTimes[deleteTimes.length - 1] ?? 0,
    avgDeleteDivLog2N: avgDeleteMs / log2N,
    avgDeleteDivN: avgDeleteMs / collectionSize,
    avgCommitMs: mean(commitTimes),
    avgDurableDeleteMs,
    p50DurableDeleteMs: percentile(durableTimes, 50),
    p95DurableDeleteMs: percentile(durableTimes, 95),
    avgDurableDeleteDivLog2N: avgDurableDeleteMs / log2N,
  };
}

async function closeQuietly(db: SimpleDbms | null): Promise<void> {
  if (!db) return;
  try {
    await db.close();
  } catch {
    // Best effort cleanup for a benchmark process that is already failing.
  }
}

async function runForSize(collectionSize: number): Promise<BenchmarkRow> {
  const sizeDir = join(RUN_DB_DIR, `n_${collectionSize}`);
  const dataPath = join(sizeDir, 'db.data');
  const logPath = join(sizeDir, 'db.log');
  rmSync(sizeDir, { recursive: true, force: true });
  await mkdir(sizeDir, { recursive: true });

  let db: SimpleDbms | null = null;
  let reopened: SimpleDbms | null = null;

  try {
    db = await SimpleDbms.create(new RealFile(dataPath), new RealFile(logPath), hnswConfig());

    const buildStartedAt = performance.now();
    for (let index = 0; index < collectionSize; index += 1) {
      await db.insertDocumentObject(COLLECTION, makeDocument(index));
      if ((index + 1) % BUILD_COMMIT_INTERVAL === 0) {
        await db.commit();
      }

      const shouldLog = index + 1 === collectionSize || (collectionSize >= 10_000 && (index + 1) % 10_000 === 0);
      if (shouldLog) {
        process.stdout.write(
          renderProgressLine(`build-${collectionSize}`, index + 1, collectionSize, buildStartedAt, `\n`),
        );
      }
    }
    await db.commit();
    const buildInsertWallMs = performance.now() - buildStartedAt;

    const deleteIds = chooseDeleteIds(collectionSize, DELETE_COUNT);
    const samples: DeleteSample[] = [];
    const deleteStartedAt = performance.now();

    for (const id of deleteIds) {
      const deleteOnlyStartedAt = performance.now();
      await db.deleteDocumentById(COLLECTION, id);
      const deleteOnlyMs = performance.now() - deleteOnlyStartedAt;

      const commitStartedAt = performance.now();
      await db.commit();
      const commitMs = performance.now() - commitStartedAt;

      samples.push({ id, deleteOnlyMs, commitMs, durableMs: deleteOnlyMs + commitMs });

      process.stdout.write(
        renderProgressLine(
          `delete-${collectionSize}`,
          samples.length,
          deleteIds.length,
          deleteStartedAt,
          `latest=${deleteOnlyMs.toFixed(3)}ms commit=${commitMs.toFixed(3)}ms\n`,
        ),
      );
    }

    const sanityIds = semanticSanityIds(deleteIds);
    const logicalDeleteCheckMs = await expectDeletedDocumentsAreGone(db, deleteIds);
    const sanitySearchBeforeReopenMs = await expectSemanticSearchExcludes(db, sanityIds, collectionSize);

    await db.close();
    db = null;

    reopened = await SimpleDbms.open(new RealFile(dataPath), new RealFile(logPath), hnswConfig());
    const sanitySearchAfterReopenMs = await expectSemanticSearchExcludes(reopened, sanityIds, collectionSize);

    const row = summarize(collectionSize, samples, {
      buildInsertWallMs,
      sanitySearchBeforeReopenMs,
      sanitySearchAfterReopenMs,
      logicalDeleteCheckMs,
    });

    process.stdout.write(
      `[summary-${collectionSize}] avg=${row.avgDeleteMs.toFixed(3)}ms p50=${row.p50DeleteMs.toFixed(
        3,
      )}ms p95=${row.p95DeleteMs.toFixed(3)}ms durableAvg=${row.avgDurableDeleteMs.toFixed(3)}ms\n`,
    );

    return row;
  } finally {
    await closeQuietly(reopened);
    await closeQuietly(db);
    if (!KEEP_DB_FILES) {
      rmSync(sizeDir, { recursive: true, force: true });
    }
  }
}

function csvEscape(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? value.toString() : '';
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function writeCsv(rows: readonly BenchmarkRow[]): void {
  const columns: Array<keyof BenchmarkRow> = [
    'collectionSize',
    'deleteCount',
    'avgDeleteMs',
    'p50DeleteMs',
    'p95DeleteMs',
    'minDeleteMs',
    'maxDeleteMs',
    'avgDeleteDivLog2N',
    'avgDeleteDivN',
    'avgCommitMs',
    'avgDurableDeleteMs',
    'p50DurableDeleteMs',
    'p95DurableDeleteMs',
    'avgDurableDeleteDivLog2N',
    'buildInsertWallMs',
    'sanitySearchBeforeReopenMs',
    'sanitySearchAfterReopenMs',
    'logicalDeleteCheckMs',
  ];
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvEscape(row[column])).join(','));
  }
  writeFileSync(CSV_FILE, `${lines.join('\n')}\n`);
}

async function main(): Promise<void> {
  ensureBenchmarkDirs();
  rmSync(RUN_DB_DIR, { recursive: true, force: true });
  await mkdir(RUN_DB_DIR, { recursive: true });

  const startedAt = performance.now();
  const rows: BenchmarkRow[] = [];

  process.stdout.write(
    `Running SimpleDbms public delete benchmark sizes=${SIZES.join(',')} deletes=${DELETE_COUNT} ` +
      `dimension=${DIMENSION} M=${M} efConstruction=${EF_CONSTRUCTION} efSearch=${EF_SEARCH}\n`,
  );

  for (const collectionSize of SIZES) {
    rows.push(await runForSize(collectionSize));
    writeCsv(rows);
  }

  const jsonPath = writeJsonResult(JSON_FILE, {
    meta: {
      description: 'SimpleDbms.deleteDocumentById timing on HNSW-backed collections with deterministic embeddings.',
      sizes: SIZES,
      deleteCount: DELETE_COUNT,
      buildCommitInterval: BUILD_COMMIT_INTERVAL,
      dimension: DIMENSION,
      M,
      efConstruction: EF_CONSTRUCTION,
      efSearch: EF_SEARCH,
      keepDbFiles: KEEP_DB_FILES,
      elapsedMs: performance.now() - startedAt,
    },
    rows,
  });

  process.stdout.write(`Saved CSV to ${CSV_FILE}\n`);
  process.stdout.write(`Saved JSON to ${jsonPath}\n`);
  process.stdout.write(`Elapsed ${formatDurationMs(performance.now() - startedAt)}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
