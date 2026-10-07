// @author: Alec Van Vlerken
// @date: 2026-05-07

import assert from 'assert';
import { describe, it } from 'vitest';

import {
  deleteDocuments,
  insertDocuments,
  makeBenchmarkDb,
  queryIds,
  snapshotDatabase,
} from '../../../benchmarks/incremental-compaction/shared/benchmark-utils.mjs';

describe('incremental compaction consistency', () => {
  it('preserves documents, indexed queries, cursors, and semantic search after compaction', async () => {
    const { db } = await makeBenchmarkDb({ hnsw: true });

    await insertDocuments(db, 'items', 'free', 18, {
      payloadWords: 240,
      group: 'free',
      indexedFields: 3,
      semanticText: 'semantic free consistency',
    });
    await insertDocuments(db, 'users', 'olduser', 8, { payloadWords: 80, group: 'old', indexedFields: 2 });
    await db.commit();

    await insertDocuments(db, 'items', 'tail', 24, {
      payloadWords: 240,
      group: 'tail',
      indexedFields: 3,
      semanticText: 'semantic tail consistency',
    });
    await insertDocuments(db, 'users', 'tailuser', 8, { payloadWords: 80, group: 'tail', indexedFields: 2 });
    await db.commit();

    await deleteDocuments(db, 'items', 'free', 18);
    await deleteDocuments(db, 'users', 'olduser', 8);
    await db.commit();

    const before = await snapshotDatabase(db);
    const semanticBefore = (await db.semanticSearch('items', 'semantic tail consistency', 5)).map((doc) =>
      String(doc.getId()),
    );
    const statsBefore = await db.getCompactionStorageStats();

    const result = await db.compactIfNeeded({
      maxAmplification: 1.25,
      softAmplification: 1.25,
      targetBatchDocuments: 4,
      targetBatchUnits: 4,
      maxStepsPerRun: 20,
    });
    await db.commit();

    const after = await snapshotDatabase(db);
    const semanticAfter = (await db.semanticSearch('items', 'semantic tail consistency', 5)).map((doc) =>
      String(doc.getId()),
    );
    const statsAfter = await db.getCompactionStorageStats();

    assert(result === null || result.didWork || result.blocked === true);
    assert.deepStrictEqual(after, before);
    assert.deepStrictEqual(await queryIds(db, 'items', 'group', 'tail'), before.indexedResultIds['items:group:tail']);
    assert(semanticAfter.some((id) => semanticBefore.includes(id)));
    assert(statsAfter.fileSizeBytes <= statsBefore.fileSizeBytes);

    await db.close();
  });
});
