// @author: Alec Van Vlerken
// @date: 2026-05-08

import assert from 'assert';
import { describe, it } from 'vitest';

import { MockFile } from '../core/mockfile.mjs';
import { DbmsBack, type HnswConfig } from '../dbms/dbmsback.mjs';
import { JSONtoDocument, type Document } from '../dbms/document.mjs';
import { vacuumCompactInto } from './compaction.mjs';

const queries = ['brown cat', 'black dog', 'orange fox'];

describe('cross-collection isolation after compaction', () => {
  it('keeps HNSW results scoped to their collection after incremental compaction and reopen', async () => {
    const database = await makeIsolationDb();
    await buildIsolationDataset(database.db);

    const before = await captureIsolationSnapshot(database.db);
    const result = await database.db.compactIfNeeded(compactionPolicy());
    await database.db.commit();

    assert(result !== null);
    assert.strictEqual(result.didWork, true);

    assert.deepStrictEqual(await captureIsolationSnapshot(database.db), before);

    await database.db.close();
    const reopened = await DbmsBack.open(database.data, database.log, database.hnswConfig);
    assert.deepStrictEqual(await captureIsolationSnapshot(reopened), before);

    await reopened.close();
  });

  it('keeps HNSW results scoped to their collection after full vacuum and reopen', async () => {
    const source = await makeIsolationDb();
    await buildIsolationDataset(source.db);
    const before = await captureIsolationSnapshot(source.db);

    const tempData = new MockFile(4096);
    const tempLog = new MockFile(4096);
    const vacuum = await vacuumCompactInto({
      source: source.db,
      tempDataFile: tempData,
      tempLogFile: tempLog,
      validate: true,
      rebuildHnsw: true,
    });

    assert.deepStrictEqual(await captureIsolationSnapshot(vacuum.target), before);

    await vacuum.target.commit();
    await vacuum.target.close();
    const reopened = await DbmsBack.open(tempData, tempLog, source.hnswConfig);
    assert.deepStrictEqual(await captureIsolationSnapshot(reopened), before);

    await reopened.close();
    await source.db.close();
  });
});

async function makeIsolationDb(): Promise<{ db: DbmsBack; data: MockFile; log: MockFile; hnswConfig: HnswConfig }> {
  const data = new MockFile(4096);
  const log = new MockFile(4096);
  const hnswConfig = makeIsolationHnswConfig();
  const db = new DbmsBack(data, log, hnswConfig);
  await db.create();
  return { db, data, log, hnswConfig };
}

async function buildIsolationDataset(db: DbmsBack): Promise<void> {
  for (let i = 0; i < 18; i++) {
    await insertDoc(db, 'animals-a', `dead-a-${i.toString().padStart(2, '0')}`, `deleted brown cat ${i}`, 160);
  }

  for (const collection of ['animals-a', 'animals-b']) {
    await insertDoc(db, collection, `${collection}-brown-cat`, 'brown cat collection scoped document', 80);
    await insertDoc(db, collection, `${collection}-black-dog`, 'black dog collection scoped document', 80);
    await insertDoc(db, collection, `${collection}-orange-fox`, 'orange fox collection scoped document', 80);
    await insertDoc(db, collection, `${collection}-rabbit`, 'white rabbit collection scoped document', 80);
  }

  await db.commit();

  for (let i = 0; i < 18; i++) {
    await db.deleteDocument(`dead-a-${i.toString().padStart(2, '0')}`, 'animals-a');
  }
  await db.commit();
}

async function insertDoc(db: DbmsBack, collection: string, id: string, text: string, payloadWords: number): Promise<void> {
  await db.insertDocument(
    JSONtoDocument(
      JSON.stringify({
        id,
        group: collection,
        text,
        _payload: `${text} `.repeat(payloadWords),
      }),
      collection,
    ),
  );
}

async function captureIsolationSnapshot(db: DbmsBack): Promise<Record<string, string[]>> {
  const snapshot: Record<string, string[]> = {};
  for (const collection of ['animals-a', 'animals-b']) {
    for (const query of queries) {
      const results = await db.semanticSearch(collection, query, 3);
      assertCollectionOnly(collection, results);
      snapshot[`${collection}:${query}`] = results.map((doc) => String(doc.getId()));
    }
  }
  return snapshot;
}

function assertCollectionOnly(collection: string, results: Document[]): void {
  assert(results.length > 0);
  for (const doc of results) {
    assert.strictEqual(doc.getCollectionName(), collection);
  }
}

function makeIsolationHnswConfig(): HnswConfig {
  return {
    dimension: 4,
    embeddingFn: (text) => Promise.resolve(isolationEmbedding(text)),
    M: 4,
    maxStoredLevel: 4,
    efConstruction: 32,
    efSearch: 32,
  };
}

function isolationEmbedding(text: string): Float32Array {
  const normalized = text.toLowerCase();
  if (normalized.includes('brown cat')) return new Float32Array([10, 0, 0, 0]);
  if (normalized.includes('black dog')) return new Float32Array([0, 9, 0, 0]);
  if (normalized.includes('orange fox')) return new Float32Array([0, 0, 8, 0]);
  if (normalized.includes('white rabbit')) return new Float32Array([0, 0, 0, 7]);
  return new Float32Array([1, 1, 1, 1]);
}

function compactionPolicy(): { maxAmplification: number; softAmplification: number; targetBatchDocuments: number; targetBatchUnits: number; maxStepsPerRun: number } {
  return {
    maxAmplification: 1.05,
    softAmplification: 1.05,
    targetBatchDocuments: 6,
    targetBatchUnits: 6,
    maxStepsPerRun: 30,
  };
}
