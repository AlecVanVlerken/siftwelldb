/**
 * Full-coverage profiling harness for SimpleDbms.
 *
 * Run with:
 *   npm run profile
 *
 * Generates CPU.*.cpuprofile in the project root.
 * Open in VS Code (click the file) or upload to https://speedscope.app.
 *
 * Covered features:
 *   - insertDocument           (plain + with compression overrides)
 *   - getDocumentById          (plain + encoded)
 *   - deleteDocumentById
 *   - editDocument
 *   - cursor iteration         (by id, by numeric field, by string field)
 *   - setFieldCompressionDefaults (gzip, deflate, none)
 *   - semanticSearch           (text → text, using a deterministic fake embedding)
 *   - commit                   (periodic + final)
 *   - Multiple collections     (so treeCache / storageCache paths are exercised)
 *
 * MockFile is used so disk I/O does not distort the CPU profile.
 * The embedding function is a cheap deterministic hash so HNSW insert/search
 * is profiled without a real model download.
 */

import { MockFile } from '../core/mockfile.mjs';
import { SimpleDbms, type HnswConfig } from '../dbms/simpledbms.mjs';

// ── Config ────────────────────────────────────────────────────────────────────
const INSERT_COUNT = 25_000; // documents per collection
const COMMIT_INTERVAL = 500;
const DIM = 64; // embedding dimension for the fake model

// Collection A: text documents with multiple iterable fields + gzip compression
const COL_TEXT = 'articles';
// Collection B: numeric-keyed documents + deflate compression
const COL_NUM = 'metrics';
// Collection C: HNSW-indexed documents (semantic search)
const COL_HNSW = 'embeddings';

// ── Deterministic fake embedding (no model download needed) ───────────────────
// Hashes the text into DIM floats in [-1, 1] using a simple LCG/XOR scheme.
function fakeEmbed(text: string): Float32Array {
  const vec = new Float32Array(DIM);
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  for (let i = 0; i < DIM; i++) {
    seed = (seed ^ (seed << 13)) >>> 0;
    seed = (seed ^ (seed >> 17)) >>> 0;
    seed = (seed ^ (seed << 5)) >>> 0;
    vec[i] = ((seed >>> 0) / 0xffff_ffff) * 2 - 1;
  }
  // L2-normalise so cosine similarity = dot product
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) vec[i] /= norm;
  return vec;
}

const hnswConfig: HnswConfig = {
  dimension: DIM,
  embeddingFn: async (text) => fakeEmbed(text),
  M: 8,
  efConstruction: 50,
  efSearch: 20,
};

// ── Document factories ────────────────────────────────────────────────────────
const CATEGORIES = ['science', 'sports', 'politics', 'tech', 'health'];

function makeTextDoc(i: number): string {
  return JSON.stringify({
    id: `article${i}`,
    title: `Article number ${i}`,
    author: `Author ${i % 50}`,
    category: CATEGORIES[i % CATEGORIES.length],
    published: i % 2 === 0 ? 'yes' : 'no',
  });
}

function makeNumDoc(i: number): string {
  return JSON.stringify({
    id: `metric${i}`,
    sensor: i % 20,
    region: `region-${i % 5}`,
  });
}

function makeEmbedDoc(i: number): string {
  return JSON.stringify({
    id: `emb${i}`,
    content: `This is document ${i} about ${CATEGORIES[i % CATEGORIES.length]}`,
    score: i % 100,
  });
}

// ── Helper ────────────────────────────────────────────────────────────────────
async function commitEvery(db: SimpleDbms, idx: number): Promise<void> {
  if ((idx + 1) % COMMIT_INTERVAL === 0) await db.commit();
}

// ── Workload ──────────────────────────────────────────────────────────────────
async function runWorkload(): Promise<void> {
  const dataFile = new MockFile(256);
  const logFile = new MockFile(4096);

  // Create with HNSW so all code paths including semanticSearch are covered
  const db = await SimpleDbms.create(dataFile, logFile, hnswConfig);

  // Set compression defaults: gzip for text docs, deflate for numeric docs
  db.setFieldCompressionDefaults(COL_TEXT, { title: 'gzip', author: 'deflate' });
  db.setFieldCompressionDefaults(COL_NUM, { region: 'deflate' });

  // ── Phase 1: Insert ────────────────────────────────────────────────────────
  console.log(`[1/7] Inserting ${INSERT_COUNT} text documents (${COL_TEXT})…`);
  for (let i = 0; i < INSERT_COUNT; i++) {
    await db.insertDocument(COL_TEXT, makeTextDoc(i), {
      compression: { title: i % 3 === 0 ? 'gzip' : 'none' },
    });
    await commitEvery(db, i);
  }
  await db.commit();

  console.log(`[2/7] Inserting ${INSERT_COUNT} numeric documents (${COL_NUM})…`);
  for (let i = 0; i < INSERT_COUNT; i++) {
    await db.insertDocument(COL_NUM, makeNumDoc(i));
    await commitEvery(db, i);
  }
  await db.commit();

  console.log(`[3/7] Inserting ${INSERT_COUNT} HNSW-indexed documents (${COL_HNSW})…`);
  for (let i = 0; i < INSERT_COUNT; i++) {
    await db.insertDocument(COL_HNSW, makeEmbedDoc(i));
    await commitEvery(db, i);
  }
  await db.commit();

  // ── Phase 2: Get by ID ────────────────────────────────────────────────────
  console.log('[4/7] Reading documents by ID (all collections)…');
  for (let i = 0; i < INSERT_COUNT; i++) {
    await db.getDocumentById(COL_TEXT, `article${i}`);
    await db.getDocumentById(COL_NUM, `metric${i}`);
    await db.getDocumentById(COL_HNSW, `emb${i}`);
  }

  // Encoded path (exercises a different deserialization branch)
  for (let i = 0; i < 200; i++) {
    await db.getDocumentById(COL_TEXT, `article${i}`, { encoded: true });
  }

  // ── Phase 3: Cursor iteration ─────────────────────────────────────────────
  console.log('[5/7] Cursor iteration…');
  // Iterate by string field with a start value
  let cursorCount = 0;
  for await (const _ of db.cursor(COL_TEXT, 'category', 'science')) {
    if (++cursorCount >= 500) break;
  }
  // Iterate by numeric field
  cursorCount = 0;
  for await (const _ of db.cursor(COL_NUM, 'sensor', 5)) {
    if (++cursorCount >= 500) break;
  }
  // Full iteration from beginning
  cursorCount = 0;
  for await (const _ of db.cursor(COL_TEXT, 'id')) {
    if (++cursorCount >= 1000) break;
  }

  // ── Phase 4: Edit ─────────────────────────────────────────────────────────
  console.log('[6/7] Editing documents…');
  for (let i = 0; i < 500; i++) {
    await db.editDocument(COL_TEXT, `article${i}`, 'published', i % 3 === 0 ? 'yes' : 'no');
    await commitEvery(db, i);
  }
  await db.commit();

  // ── Phase 5: Semantic search ───────────────────────────────────────────────
  console.log('[7/7] Semantic search…');
  const queries = CATEGORIES.flatMap((cat) => [
    `latest news about ${cat}`,
    `${cat} research findings`,
    `best ${cat} insights`,
  ]);
  for (const q of queries) {
    await db.semanticSearch(COL_HNSW, q, 10);
  }

  // ── Phase 6: Delete ────────────────────────────────────────────────────────
  console.log('[+] Deleting half of each collection…');
  for (let i = 0; i < INSERT_COUNT / 2; i++) {
    await db.deleteDocumentById(COL_TEXT, `article${i}`);
    await db.deleteDocumentById(COL_NUM, `metric${i}`);
    await db.deleteDocumentById(COL_HNSW, `emb${i}`);
    await commitEvery(db, i);
  }
  await db.commit();

  console.log('Done.');
}

await runWorkload();
