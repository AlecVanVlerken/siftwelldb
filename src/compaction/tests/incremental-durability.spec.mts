// @author: Alec Van Vlerken
// @date: 2026-05-07

import assert from 'assert';
import { describe, it } from 'vitest';

import {
  deleteDocuments,
  insertDocuments,
  makeBenchmarkDb,
  reopenBenchmarkDb,
  snapshotDatabase,
} from '../../../benchmarks/incremental-compaction/shared/benchmark-utils.mjs';

describe('incremental compaction durability', () => {
  it('keeps compacted contents and indexes correct after commit and reopen', async () => {
    const benchmark = await makeBenchmarkDb({ hnsw: true });
    const { db } = benchmark;

    await insertDocuments(db, 'items', 'free', 14, {
      payloadWords: 260,
      group: 'free',
      indexedFields: 2,
      semanticText: 'semantic free durability',
    });
    await db.commit();
    await insertDocuments(db, 'items', 'tail', 18, {
      payloadWords: 260,
      group: 'tail',
      indexedFields: 2,
      semanticText: 'semantic tail durability',
    });
    await db.commit();
    await deleteDocuments(db, 'items', 'free', 14);
    await db.commit();

    const fileBytesBefore = (await db.getCompactionStorageStats()).fileSizeBytes;
    await db.compactIfNeeded({
      maxAmplification: 1.25,
      softAmplification: 1.25,
      targetBatchDocuments: 3,
      targetBatchUnits: 3,
      maxStepsPerRun: 20,
    });
    await db.commit();

    const compactedSnapshot = await snapshotDatabase(db);
    const compactedStats = await db.getCompactionStorageStats();
    const reopened = await reopenBenchmarkDb(benchmark);
    const reopenedSnapshot = await snapshotDatabase(reopened);
    const reopenedStats = await reopened.getCompactionStorageStats();
    const semanticAfterReopen = await reopened.semanticSearch('items', 'semantic tail durability', 5);

    assert.deepStrictEqual(reopenedSnapshot, compactedSnapshot);
    assert.strictEqual(reopenedStats.fileSizeBytes, compactedStats.fileSizeBytes);
    assert(reopenedStats.fileSizeBytes <= fileBytesBefore);
    assert(semanticAfterReopen.length > 0);

    await reopened.close();
  });
});
