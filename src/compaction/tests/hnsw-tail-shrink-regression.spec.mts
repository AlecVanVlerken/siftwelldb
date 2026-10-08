import assert from 'assert';
import { describe, it } from 'vitest';

import { MockFile } from '../../../tests/helpers/mockfile.mjs';
import { DbmsBack, type HnswConfig } from '../../database/dbmsback.mjs';
import { JSONtoDocument } from '../../database/document.mjs';

function makeEmbedding(text: string): Float32Array {
  const vector = new Float32Array(6);
  const normalized = text.toLowerCase();
  if (normalized.includes('rabbit')) return new Float32Array([10, 0, 0, 0, 0, 0]);
  if (normalized.includes('dolphin')) return new Float32Array([0, 9, 0, 0, 0, 0]);
  if (normalized.includes('fox')) return new Float32Array([0, 0, 8, 0, 0, 0]);
  if (normalized.includes('tiger')) return new Float32Array([0, 0, 0, 7, 0, 0]);
  for (let i = 0; i < normalized.length; i++) {
    vector[i % vector.length] += normalized.charCodeAt(i) % 23;
  }
  return vector;
}

async function makeDb(): Promise<{ db: DbmsBack; data: MockFile; log: MockFile; hnswConfig: HnswConfig }> {
  const data = new MockFile(4096);
  const log = new MockFile(4096);
  const hnswConfig: HnswConfig = {
    dimension: 6,
    embeddingFn: (text) => Promise.resolve(makeEmbedding(text)),
    M: 4,
    maxStoredLevel: 3,
    efConstruction: 32,
    efSearch: 32,
  };
  const db = new DbmsBack(data, log, hnswConfig);
  await db.create();
  return { db, data, log, hnswConfig };
}

async function semanticIds(db: DbmsBack): Promise<string[]> {
  return (await db.semanticSearch('animals', 'rabbit', 3)).map((doc) => String(doc.getId()));
}

describe('HNSW tail shrink regression', () => {
  it('moves live HNSW tail blockers downward, trims the physical file, and preserves semantic results', async () => {
    const { db, data, log, hnswConfig } = await makeDb();

    await db.setFieldIndexed('filler', '_payload', false);
    const fillerPayload = 'free lower record block '.repeat(500);
    for (let i = 0; i < 18; i++) {
      await db.insertDocument(
        JSONtoDocument(
          JSON.stringify({
            id: i,
            value: i,
            _payload: fillerPayload,
          }),
          'filler',
        ),
      );
    }
    await db.commit();

    for (const animal of [
      { id: 'rabbit', body: 'white rabbit animal photo' },
      { id: 'dolphin', body: 'blue dolphin animal photo' },
      { id: 'fox', body: 'orange fox animal photo' },
      { id: 'tiger', body: 'striped tiger animal photo' },
    ]) {
      await db.insertDocument(JSONtoDocument(JSON.stringify(animal), 'animals'));
    }
    await db.commit();

    for (let i = 0; i < 18; i++) {
      await db.deleteDocument(i, 'filler');
    }
    await db.commit();

    const graph = await db.inspectHnswGraphStructure('animals');
    assert(!graph.some((node) => node.deleted), 'test setup should not depend on HNSW tombstones');

    const beforeSearch = await semanticIds(db);
    assert.deepStrictEqual(beforeSearch[0], 'rabbit');

    const beforeStats = await db.getCompactionStorageStats();
    const result = await db.compactIfNeeded({
      maxAmplification: 1.05,
      softAmplification: 1.05,
      targetBatchDocuments: 4,
      targetBatchUnits: 4,
      maxStepsPerRun: 80,
    });
    const afterStats = await db.getCompactionStorageStats();

    assert(result, 'database should need incremental compaction');
    assert((result.relocatedHnswUnits ?? 0) > 0, 'HNSW tail blockers should be relocated');
    assert((result.reclaimedTailBlocks ?? 0) > 0, 'tail trimming should reclaim physical blocks');
    assert(
      afterStats.fileSizeBytes < beforeStats.fileSizeBytes,
      `expected physical file shrink from ${beforeStats.fileSizeBytes.toString()} to below it, got ${afterStats.fileSizeBytes.toString()}`,
    );

    assert.deepStrictEqual(await semanticIds(db), beforeSearch);

    await db.commit();
    await db.close();
    const reopened = await DbmsBack.open(data, log, hnswConfig);
    assert.deepStrictEqual(await semanticIds(reopened), beforeSearch);
    await reopened.close();
  });
});
