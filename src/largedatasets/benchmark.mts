/**
 * Benchmark suite for the large-datasets feature.
 *
 * Measures:
 *   1. Single article fetch latency
 *   2. Word search latency (title index)
 *   3. Content search latency (content index, if available)
 *   4. Cursor-based pagination latency across pages
 *   5. Offset-based pagination latency across offsets
 *
 * Usage:
 *   node build/largedatasets/benchmark.mjs <database.db> [--runs N] [--page-size N]
 */

import { SimpleDbms } from '../dbms/simpledbms.mjs';
import { RealFile } from '../core/file.mjs';
import { searchWordIndex, searchContentIndex, WORD_INDEX_COLLECTION, CONTENT_INDEX_COLLECTION } from './wordindex.mjs';
import { fetchPageCursor, fetchPageOffset } from './pagination.mjs';

const COLLECTION = 'articles';

// ── Helpers ──────────────────────────────────────────────────

interface Stats {
  avg: number;
  min: number;
  max: number;
  runs: number;
}

async function measure(fn: () => Promise<unknown>, runs: number, warmup = 3): Promise<Stats> {
  for (let i = 0; i < warmup; i++) await fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  return {
    avg: times.reduce((a, b) => a + b, 0) / times.length,
    min: Math.min(...times),
    max: Math.max(...times),
    runs,
  };
}

function fmt(ms: number): string {
  return `${ms.toFixed(3)} ms`;
}

function row(label: string, stats: Stats): void {
  console.log(
    `  ${label.padEnd(14)} avg ${fmt(stats.avg).padStart(10)}   min ${fmt(stats.min).padStart(10)}   max ${fmt(stats.max).padStart(10)}   (${stats.runs} runs)`,
  );
}

function sep(): void {
  console.log('-'.repeat(75));
}

// ── Collect sample data from DB ───────────────────────────────

async function sampleArticleIds(db: SimpleDbms, n: number): Promise<string[]> {
  const ids: string[] = [];
  for await (const json of db.cursor(COLLECTION, 'id')) {
    const doc = JSON.parse(json) as { id: string };
    ids.push(doc.id);
    if (ids.length >= n) break;
  }
  return ids;
}

async function sampleWords(db: SimpleDbms, collection: string, n: number, minDocs = 1): Promise<string[]> {
  const words: string[] = [];
  try {
    for await (const json of db.cursor(collection, 'id')) {
      const doc = JSON.parse(json) as { id: string; _docIds: string };
      const count = doc._docIds ? doc._docIds.split('|').length : 0;
      if (count >= minDocs) words.push(doc.id);
      if (words.length >= n) break;
    }
  } catch {
    // collection does not exist
  }
  return words;
}

async function collectionExists(db: SimpleDbms, collection: string): Promise<boolean> {
  try {
    for await (const _ of db.cursor(collection, 'id')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function countArticles(db: SimpleDbms): Promise<number> {
  let n = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of db.cursor(COLLECTION, 'id')) n++;
  return n;
}

// ── Cursor navigation helper ──────────────────────────────────

async function cursorAfterPages(db: SimpleDbms, pageSize: number, pages: number): Promise<string | number | undefined> {
  let cursor: string | number | undefined;
  for (let i = 0; i < pages; i++) {
    const page = await fetchPageCursor(db, {
      collection: COLLECTION,
      iterableKey: 'id',
      limit: pageSize,
      afterCursor: cursor,
    });
    if (!page.hasMore) return undefined;
    cursor = page.nextCursor;
  }
  return cursor;
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dbPath = args[0];
  const runsIdx = args.indexOf('--runs');
  const runs = runsIdx !== -1 ? parseInt(args[runsIdx + 1] ?? '30', 10) : 30;
  const pageSizeIdx = args.indexOf('--page-size');
  const pageSize = pageSizeIdx !== -1 ? parseInt(args[pageSizeIdx + 1] ?? '20', 10) : 20;

  if (!dbPath) {
    console.error('Usage: benchmark.mjs <database.db> [--runs N] [--page-size N]');
    process.exit(1);
  }

  const db = await SimpleDbms.open(new RealFile(dbPath), new RealFile(`${dbPath}.log`));

  console.log('\n' + '='.repeat(75));
  console.log('  SimpleDBMS Benchmark');
  console.log(`  Database  : ${dbPath}`);
  console.log(`  Runs/test : ${runs}  |  Warmup: 3  |  Page size: ${pageSize}`);

  console.log('  Counting articles...');
  const totalArticles = await countArticles(db);
  console.log(`  Articles  : ${totalArticles}`);
  console.log('='.repeat(75));

  // Sample data
  const articleIds = await sampleArticleIds(db, 100);
  const titleWords = await sampleWords(db, WORD_INDEX_COLLECTION, 8, 2);
  const hasContentIndex = await collectionExists(db, CONTENT_INDEX_COLLECTION);
  const contentWords = hasContentIndex ? await sampleWords(db, CONTENT_INDEX_COLLECTION, 8, 2) : [];

  if (articleIds.length === 0) {
    console.error('No articles found in database. Aborting.');
    await db.close();
    process.exit(1);
  }

  // ── 1. Single article fetch ─────────────────────────────────
  console.log('\n[1] Single Article Fetch (getDocumentById)');
  sep();
  const fetchStats = await measure(async () => {
    const id = articleIds[Math.floor(Math.random() * articleIds.length)];
    await db.getDocumentById(COLLECTION, id);
  }, runs);
  row('fetch', fetchStats);

  // ── 2. Word search (title index) ────────────────────────────
  console.log('\n[2] Word Search — Title Index (_word_index)');
  sep();
  if (titleWords.length === 0) {
    console.log('  No title index found — skipping.');
  } else {
    for (const word of titleWords) {
      const result = await searchWordIndex(db, word, 200, 0);
      const stats = await measure(() => searchWordIndex(db, word, 200, 0), runs);
      console.log(
        `  "${word.padEnd(18)}"  ${String(result.total).padStart(6)} docs   avg ${fmt(stats.avg).padStart(10)}   min ${fmt(stats.min).padStart(10)}   max ${fmt(stats.max).padStart(10)}`,
      );
    }
  }

  // ── 3. Content search ───────────────────────────────────────
  console.log('\n[3] Content Search — Content Index (_content_index)');
  sep();
  if (!hasContentIndex || contentWords.length === 0) {
    console.log('  No content index found — skipping.');
    console.log('  (Content index is built during Wikipedia import, not seed.)');
  } else {
    for (const word of contentWords) {
      const result = await searchContentIndex(db, word, 200, 0);
      const stats = await measure(() => searchContentIndex(db, word, 200, 0), runs);
      console.log(
        `  "${word.padEnd(18)}"  ${String(result.total).padStart(6)} docs   avg ${fmt(stats.avg).padStart(10)}   min ${fmt(stats.min).padStart(10)}   max ${fmt(stats.max).padStart(10)}`,
      );
    }
  }

  // ── 4. Cursor pagination ────────────────────────────────────
  console.log('\n[4] Cursor-Based Pagination (O(page_size) per page)');
  sep();
  const cursorPages = [1, 5, 10, 20, 50].filter((p) => p * pageSize <= totalArticles);
  for (const pageNum of cursorPages) {
    const cursor = await cursorAfterPages(db, pageSize, pageNum - 1);
    if (cursor === undefined && pageNum > 1) {
      console.log(`  Page ${pageNum}: not enough articles — skipping.`);
      continue;
    }
    const stats = await measure(
      () =>
        fetchPageCursor(db, {
          collection: COLLECTION,
          iterableKey: 'id',
          limit: pageSize,
          afterCursor: cursor,
        }),
      runs,
    );
    row(`page ${pageNum}`, stats);
  }
  console.log(`  → Expected: constant time regardless of page number`);

  // ── 5. Offset pagination ────────────────────────────────────
  console.log('\n[5] Offset-Based Pagination (O(offset) per page)');
  sep();
  const offsets = [0, 50, 100, 250, 500].filter((o) => o + pageSize <= totalArticles);
  for (const offset of offsets) {
    const stats = await measure(
      () =>
        fetchPageOffset(db, {
          collection: COLLECTION,
          iterableKey: 'id',
          limit: pageSize,
          offset,
        }),
      runs,
    );
    row(`offset ${offset}`, stats);
  }
  console.log(`  → Expected: time grows with offset`);

  console.log('\n' + '='.repeat(75));
  console.log('  Benchmark complete.');
  console.log('='.repeat(75) + '\n');

  await db.close();
}

main().catch((err: unknown) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
