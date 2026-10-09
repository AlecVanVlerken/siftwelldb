// @author: Alec Van Vlerken
// @date: 2026-04-28

/**
 * vacuum-benchmark.mts
 * -------------------------
 * This script benchmarks the vacuum compaction subsystem.
 *
 * The benchmark:
 *   - creates a fragmented database
 *   - inserts a large deterministic dataset
 *   - deletes a substantial portion of documents
 *   - edits many surviving documents
 *   - inserts additional documents after fragmentation
 *   - measures query performance before vacuum
 *   - runs vacuum compaction
 *   - measures query performance after vacuum
 *   - prints file size and block count estimates before and after
 */

import assert from 'assert';
import { performance } from 'perf_hooks';

import { MockFile } from '../../tests/helpers/mockfile.mjs';
import { DbmsBack, type HnswConfig } from '../../src/database/dbmsback.mjs';
import { JSONtoDocument, documentToJSON, type Document } from '../../src/database/document.mjs';
import { CollectionCatalog } from '../../src/compaction/vacuum/collectioncatalog.mjs';

type BenchmarkConfig = {
  articleCount: number;
  userCount: number;
  logCount: number;
  reinsertionArticleCount: number;
  reinsertionUserCount: number;
  deleteModulo: number;
  editModulo: number;
  idLookupIterations: number;
  cursorIterations: number;
  semanticIterations: number;
  runSemanticQueries: boolean;
};

type QueryBenchmarkResult = {
  idLookupMs: number;
  cursorQueryMs: number;
  semanticQueryMs?: number;
};

type StorageStats = {
  dataFileBytes?: number;
  logFileBytes?: number;
  blockSize?: number;
  estimatedBlockCount?: number;
};

type Snapshot = {
  collections: string[];
  documentCount: number;
  docsByCollection: Record<string, Record<string, string>>;
  compressionMeta: Record<string, Record<string, string>>;
};

const DEFAULT_CONFIG: BenchmarkConfig = {
  articleCount: 4000,
  userCount: 2000,
  logCount: 6000,
  reinsertionArticleCount: 1200,
  reinsertionUserCount: 600,
  deleteModulo: 3,
  editModulo: 5,
  idLookupIterations: 1200,
  cursorIterations: 40,
  semanticIterations: 30,
  runSemanticQueries: true,
};

const testHnswConfig: HnswConfig = {
  dimension: 3,
  embeddingFn: (text: string) => {
    const out = new Float32Array(3);
    out[0] = text.length;
    out[1] = text.charCodeAt(0) || 0;
    out[2] = 1;
    return Promise.resolve(out);
  },
};

async function main(): Promise<void> {
  const config = DEFAULT_CONFIG;
  const source = await makeDbmsBack(testHnswConfig);

  console.log('--- VACUUM BENCHMARK: CONFIG ---');
  console.log(config);
  console.log('');

  const workloadStart = performance.now();
  await buildFragmentedWorkload(source, config);
  await source.commit();
  const workloadMs = performance.now() - workloadStart;

  const beforeSnapshot = await snapshotDb(source);
  const beforeStats = readStorageStats(source);
  const beforeQueryMs = await benchmarkQueries(source, config);

  console.log('--- BEFORE VACUUM ---');
  printSnapshotSummary(beforeSnapshot);
  printStorageStats(beforeStats);
  printQueryBenchmark(beforeQueryMs);
  console.log('');

  const temp = makeTempFiles();

  const vacuumStart = performance.now();
  const compacted = await source.vacuumCompactInto(temp.data, temp.log);
  const vacuumMs = performance.now() - vacuumStart;

  const afterSnapshot = await snapshotDb(compacted);
  const afterStats = readStorageStats(compacted);
  const afterQueryMs = await benchmarkQueries(compacted, config);

  console.log('--- AFTER VACUUM ---');
  printSnapshotSummary(afterSnapshot);
  printStorageStats(afterStats);
  printQueryBenchmark(afterQueryMs);
  console.log('');

  console.log('--- VACUUM TIMING ---');
  console.log(`Workload build time: ${formatMs(workloadMs)}`);
  console.log(`Vacuum time:         ${formatMs(vacuumMs)}`);
  console.log('');

  // ---------------------------------------------------------
  // Consistency checks
  // ---------------------------------------------------------
  assert.deepStrictEqual(afterSnapshot.collections, beforeSnapshot.collections);
  assert.strictEqual(afterSnapshot.documentCount, beforeSnapshot.documentCount);
  assert.deepStrictEqual(afterSnapshot.docsByCollection, beforeSnapshot.docsByCollection);
  assert.deepStrictEqual(afterSnapshot.compressionMeta, beforeSnapshot.compressionMeta);

  const article = (await compacted.getDocument('a1', 'articles')) as Document;
  const user = (await compacted.getDocument('u1', 'users')) as Document;
  const log = (await compacted.getDocument('l1', 'logs')) as Document;

  assert.strictEqual(article.getId(), 'a1');
  assert.strictEqual(user.getId(), 'u1');
  assert.strictEqual(log.getId(), 'l1');

  const reArticle = (await compacted.getDocument('ra0', 'articles')) as Document;
  const reUser = (await compacted.getDocument('ru0', 'users')) as Document;

  assert.strictEqual(reArticle.getId(), 'ra0');
  assert.strictEqual(reUser.getId(), 'ru0');

  await assert.rejects(() => compacted.getDocument('a0', 'articles'));
  await assert.rejects(() => compacted.getDocument('u0', 'users'));
  await assert.rejects(() => compacted.getDocument('l0', 'logs'));

  console.log('--- CONSISTENCY CHECK ---');
  console.log('PASS');
  console.log('');

  console.log('--- BENCHMARK COMPLETE ---');
}

//
// Setup helpers
//
async function makeDbmsBack(hnswConfig?: HnswConfig): Promise<DbmsBack> {
  const data = new MockFile(4096);
  const log = new MockFile(4096);
  const db = new DbmsBack(data, log, hnswConfig);
  await db.create();
  await db.setFieldIndexed('articles', '_body', false);
  await db.setFieldIndexed('articles', '_tags', false);
  return db;
}

function makeTempFiles() {
  return {
    data: new MockFile(4096),
    log: new MockFile(4096),
  };
}

//
// Workload builder
//
async function buildFragmentedWorkload(db: DbmsBack, config: BenchmarkConfig): Promise<void> {
  db.setFieldCompressionDefaults('articles', {
    title: 'gzip',
    _body: 'deflate',
    _tags: 'gzip',
  });

  db.setFieldCompressionDefaults('users', {
    _bio: 'gzip',
  });

  db.setFieldCompressionDefaults('logs', {
    _message: 'gzip',
  });

  // ---------------------------------------------------------
  // Initial inserts
  // ---------------------------------------------------------
  for (let i = 0; i < config.articleCount; i++) {
    await db.insertDocument(makeArticleDocument(`a${i.toString()}`, i));
  }

  for (let i = 0; i < config.userCount; i++) {
    await db.insertDocument(makeUserDocument(`u${i.toString()}`, i));
  }

  for (let i = 0; i < config.logCount; i++) {
    await db.insertDocument(makeLogDocument(`l${i.toString()}`, i));
  }

  // ---------------------------------------------------------
  // Deletes to create many holes
  // ---------------------------------------------------------
  for (let i = 0; i < config.articleCount; i++) {
    if (i % config.deleteModulo === 0) {
      await db.deleteDocument(`a${i.toString()}`, 'articles');
    }
  }

  for (let i = 0; i < config.userCount; i++) {
    if (i % config.deleteModulo === 0) {
      await db.deleteDocument(`u${i.toString()}`, 'users');
    }
  }

  for (let i = 0; i < config.logCount; i++) {
    if (i % config.deleteModulo === 0) {
      await db.deleteDocument(`l${i.toString()}`, 'logs');
    }
  }

  // ---------------------------------------------------------
  // Edits to force delete + reinsert churn
  // ---------------------------------------------------------
  for (let i = 1; i < config.articleCount; i++) {
    if (i % config.deleteModulo === 0) continue;
    if (i % config.editModulo !== 0) continue;

    await db.editDocumentByID('articles', `a${i.toString()}`, '_body', makeLargeArticleBody(i, 2));
  }

  for (let i = 1; i < config.userCount; i++) {
    if (i % config.deleteModulo === 0) continue;
    if (i % config.editModulo !== 0) continue;

    await db.editDocumentByID('users', `u${i.toString()}`, '_bio', makeMediumUserBio(i, 2));
  }

  for (let i = 1; i < config.logCount; i++) {
    if (i % config.deleteModulo === 0) continue;
    if (i % config.editModulo !== 0) continue;

    await db.editDocumentByID('logs', `l${i.toString()}`, '_message', makeSmallLogMessage(i, 3));
  }

  // ---------------------------------------------------------
  // Reinsert additional documents after fragmentation
  // ---------------------------------------------------------
  for (let i = 0; i < config.reinsertionArticleCount; i++) {
    await db.insertDocument(makeArticleDocument(`ra${i.toString()}`, i + 100_000));
  }

  for (let i = 0; i < config.reinsertionUserCount; i++) {
    await db.insertDocument(makeUserDocument(`ru${i.toString()}`, i + 200_000));
  }
}

//
// Document factories
//
function makeArticleDocument(id: string, seed: number): Document {
  return JSONtoDocument(
    JSON.stringify({
      id,
      title: `Article ${seed.toString()}`,
      _body: makeLargeArticleBody(seed, 1),
      _tags: `database, vacuum, benchmark, seed-${seed.toString()}`,
      category: `cat-${(seed % 12).toString()}`,
      score: seed,
    }),
    'articles',
  );
}

function makeUserDocument(id: string, seed: number): Document {
  return JSONtoDocument(
    JSON.stringify({
      id,
      name: `User ${seed.toString()}`,
      city: `city-${(seed % 20).toString()}`,
      age: 18 + (seed % 50),
      _bio: makeMediumUserBio(seed, 1),
    }),
    'users',
  );
}

function makeLogDocument(id: string, seed: number): Document {
  return JSONtoDocument(
    JSON.stringify({
      id,
      level: ['info', 'warn', 'error'][seed % 3],
      service: `svc-${(seed % 15).toString()}`,
      _message: makeSmallLogMessage(seed, 1),
      ts: seed,
    }),
    'logs',
  );
}

function makeLargeArticleBody(seed: number, multiplier: number): string {
  const unit = `article-${seed.toString()} compaction free-block metadata benchmark `;
  return unit.repeat(20 * multiplier);
}

function makeMediumUserBio(seed: number, multiplier: number): string {
  const unit = `user-${seed.toString()} bio benchmark `;
  return unit.repeat(8 * multiplier);
}

function makeSmallLogMessage(seed: number, multiplier: number): string {
  const unit = `log-${seed.toString()} event `;
  return unit.repeat(3 * multiplier);
}

//
// Query benchmarks
//
async function benchmarkQueries(db: DbmsBack, config: BenchmarkConfig): Promise<QueryBenchmarkResult> {
  const idLookupStart = performance.now();

  for (let i = 0; i < config.idLookupIterations; i++) {
    const n = (i * 7 + 1) % config.articleCount;
    if (n % config.deleteModulo === 0) continue;

    const id = `a${n.toString()}`;
    const doc = (await db.getDocument(id, 'articles')) as Document;
    assert.strictEqual(doc.getId(), id);
  }

  const idLookupMs = performance.now() - idLookupStart;

  const cursorQueryStart = performance.now();

  for (let i = 0; i < config.cursorIterations; i++) {
    const category = `cat-${(i % 12).toString()}`;
    const cursor = await db.cursor('articles', 'category', category);

    let seen = 0;
    for await (const doc of cursor) {
      void doc;
      seen += 1;
      if (seen >= 30) break;
    }
  }

  const cursorQueryMs = performance.now() - cursorQueryStart;

  if (!config.runSemanticQueries) {
    return {
      idLookupMs,
      cursorQueryMs,
    };
  }

  const semanticQueryStart = performance.now();

  for (let i = 0; i < config.semanticIterations; i++) {
    const results = await db.semanticSearch('articles', 'database compaction metadata', 10);
    assert.strictEqual(Array.isArray(results), true);
  }

  const semanticQueryMs = performance.now() - semanticQueryStart;

  return {
    idLookupMs,
    cursorQueryMs,
    semanticQueryMs,
  };
}

//
// Snapshot / consistency helpers
//
async function snapshotDb(db: DbmsBack): Promise<Snapshot> {
  const catalog = new CollectionCatalog(db);
  const collections = catalog.listCollections();

  const docsByCollection: Record<string, Record<string, string>> = {};
  let documentCount = 0;

  for (const collection of collections) {
    docsByCollection[collection] = {};

    if (!catalog.hasIdTree(collection)) {
      continue;
    }

    const cursor = await db.cursor(collection, 'id');
    for await (const doc of cursor) {
      docsByCollection[collection][String(doc.getId())] = documentToJSON(doc);
      documentCount += 1;
    }
  }

  const compressionMeta = db.getVacuumCompressionMetaSnapshot() as Record<string, Record<string, string>>;

  return {
    collections,
    documentCount,
    docsByCollection,
    compressionMeta,
  };
}

//
// Storage stats
//
function readStorageStats(db: DbmsBack): StorageStats {
  const dataFile = db.getVacuumDataFile();
  const logFile = db.getVacuumLogFile();

  const dataFileBytes = tryReadMockFileSize(dataFile);
  const logFileBytes = tryReadMockFileSize(logFile);
  const blockSize = tryReadBlockSize(db);

  let estimatedBlockCount: number | undefined;
  if (dataFileBytes !== undefined && blockSize !== undefined && blockSize > 0) {
    estimatedBlockCount = Math.ceil(dataFileBytes / blockSize);
  }

  return {
    dataFileBytes,
    logFileBytes,
    blockSize,
    estimatedBlockCount,
  };
}

function tryReadBlockSize(db: DbmsBack): number | undefined {
  const maybeDb = db as unknown as {
    freeblockFile?: {
      _getBlockSize?: () => number;
    };
  };

  return maybeDb.freeblockFile?._getBlockSize?.();
}

function tryReadMockFileSize(file: unknown): number | undefined {
  const record = file as Record<string, unknown>;

  const directCandidates = ['size', 'length', 'byteLength'];
  for (const key of directCandidates) {
    const value = record[key];
    if (typeof value === 'number') {
      return value;
    }
  }

  const nestedCandidates = ['buffer', 'data', 'contents', '_buffer', '_data'];
  for (const key of nestedCandidates) {
    const value = record[key] as Record<string, unknown> | undefined;
    if (!value) continue;

    if (typeof value['length'] === 'number') return value['length'];
    if (typeof value['byteLength'] === 'number') return value['byteLength'];
  }

  return undefined;
}

//
// Output helpers
//
function printSnapshotSummary(snapshot: Snapshot): void {
  console.log(`Collections:      ${snapshot.collections.join(', ')}`);
  console.log(`Document count:   ${snapshot.documentCount.toString()}`);
}

function printStorageStats(stats: StorageStats): void {
  console.log(`Data file bytes:  ${formatMaybeNumber(stats.dataFileBytes)}`);
  console.log(`Log file bytes:   ${formatMaybeNumber(stats.logFileBytes)}`);
  console.log(`Block size:       ${formatMaybeNumber(stats.blockSize)}`);
  console.log(`Estimated blocks: ${formatMaybeNumber(stats.estimatedBlockCount)}`);
}

function printQueryBenchmark(result: QueryBenchmarkResult): void {
  console.log(`ID lookup time:   ${formatMs(result.idLookupMs)}`);
  console.log(`Cursor query time:${formatMs(result.cursorQueryMs)}`);
  if (result.semanticQueryMs !== undefined) {
    console.log(`Semantic time:    ${formatMs(result.semanticQueryMs)}`);
  }
}

function formatMs(ms: number): string {
  return `${ms.toFixed(2)} ms`;
}

function formatMaybeNumber(value: number | undefined): string {
  return value === undefined ? 'unknown' : value.toString();
}

void main().catch((err: unknown) => {
  console.error('VACUUM BENCHMARK FAILED');
  console.error(err);
  process.exitCode = 1;
});
