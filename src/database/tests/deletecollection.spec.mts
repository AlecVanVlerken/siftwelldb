import assert from 'assert';
import { describe, it } from 'vitest';

import { MockFile } from '../../../tests/helpers/mockfile.mjs';
import { DbmsBack, type HnswConfig } from '../dbmsback.mjs';
import { JSONtoDocument } from '../document.mjs';

function makeEmbedding(text: string): Float32Array {
  const vector = new Float32Array(6);
  for (let i = 0; i < text.length; i++) {
    vector[i % vector.length] += text.charCodeAt(i) % 29;
  }
  return vector;
}

async function makeDb(hnswConfig?: HnswConfig): Promise<{ db: DbmsBack; data: MockFile; log: MockFile }> {
  const data = new MockFile(4096);
  const log = new MockFile(4096);
  const db = new DbmsBack(data, log, hnswConfig);
  await db.create();
  return { db, data, log };
}

describe('DbmsBack.deleteCollection storage cleanup', () => {
  it('frees dropped collection records and B-tree nodes so incremental compaction can trim the file', async () => {
    const { db, data, log } = await makeDb();
    await db.setFieldIndexed('dropme', '_payload', false);
    const payload = 'collection drop record payload '.repeat(180);

    for (let i = 0; i < 30; i++) {
      await db.insertDocument(
        JSONtoDocument(
          JSON.stringify({
            id: `doc-${i.toString()}`,
            tag: i % 2 === 0 ? 'even' : 'odd',
            rank: i,
            _payload: payload,
          }),
          'dropme',
        ),
      );
    }
    await db.commit();

    const before = await db.getCompactionStorageStats();

    await db.deleteCollection('dropme');
    await db.commit();

    const afterDelete = await db.getCompactionStorageStats();
    assert(
      afterDelete.freeBlocks > before.freeBlocks,
      'dropping a collection should add owned blocks to the free list',
    );
    assert(!(await db.getCollections()).includes('dropme'));

    const compactResult = await db.compactIfNeeded({
      maxAmplification: 1.01,
      softAmplification: 1.01,
      targetBatchDocuments: 8,
      targetBatchUnits: 8,
      maxStepsPerRun: 20,
    });
    const afterCompact = await db.getCompactionStorageStats();

    assert(compactResult, 'a dropped collection with a free tail should need compaction');
    assert((compactResult.reclaimedTailBlocks ?? 0) > 0, 'tail reclamation should physically trim freed blocks');
    assert(afterCompact.fileSizeBytes < before.fileSizeBytes);

    await db.close();
    const reopened = await DbmsBack.open(data, log);
    assert(!(await reopened.getCollections()).includes('dropme'));
    await reopened.close();
  });

  it('frees dropped HNSW-backed collection graph/vector storage and removes semantic results', async () => {
    const hnswConfig: HnswConfig = {
      dimension: 6,
      embeddingFn: (text) => Promise.resolve(makeEmbedding(text)),
      M: 4,
      maxStoredLevel: 3,
      efConstruction: 32,
      efSearch: 32,
    };
    const { db, data, log } = await makeDb(hnswConfig);

    for (let i = 0; i < 8; i++) {
      await db.setFieldIndexed('base', '_payload', false);
      await db.setFieldIndexed('animals', '_payload', false);

      await db.insertDocument(
        JSONtoDocument(
          JSON.stringify({
            id: `base-${i.toString()}`,
            value: i,
            _payload: 'low live filler '.repeat(250),
          }),
          'base',
        ),
      );
    }
    await db.commit();

    for (const animal of ['rabbit', 'dolphin', 'fox', 'tiger', 'otter', 'whale']) {
      await db.insertDocument(
        JSONtoDocument(
          JSON.stringify({
            id: animal,
            kind: animal,
            body: `${animal} semantic image text`,
            _payload: 'hnsw collection payload '.repeat(120),
          }),
          'animals',
        ),
      );
    }
    await db.commit();

    assert((await db.semanticSearch('animals', 'rabbit', 3)).length > 0);
    const before = await db.getCompactionStorageStats();

    await db.deleteCollection('animals');
    await db.commit();

    const afterDelete = await db.getCompactionStorageStats();
    assert(afterDelete.freeBlocks > before.freeBlocks, 'HNSW graph/vector storage should be freed on collection drop');
    assert.deepStrictEqual(await db.semanticSearch('animals', 'rabbit', 3), []);

    const compactResult = await db.compactIfNeeded({
      maxAmplification: 1.01,
      softAmplification: 1.01,
      targetBatchDocuments: 8,
      targetBatchUnits: 8,
      maxStepsPerRun: 40,
    });
    const afterCompact = await db.getCompactionStorageStats();

    assert(compactResult, 'freed HNSW tail blocks should be reclaimable');
    assert((compactResult.reclaimedTailBlocks ?? 0) > 0);
    assert(afterCompact.fileSizeBytes < before.fileSizeBytes);

    await db.close();
    const reopened = await DbmsBack.open(data, log, hnswConfig);
    assert.deepStrictEqual(await reopened.semanticSearch('animals', 'rabbit', 3), []);
    assert((await reopened.getDocument('base-0', 'base')) !== null);
    await reopened.close();
  });
});
