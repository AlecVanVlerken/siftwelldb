// @author: Alec Van Vlerken
// @date: 2026-05-07

import assert from 'assert';
import { describe, it } from 'vitest';

import {
  captureCrossStructureSnapshot,
  assertCrossStructureSnapshotsEqual,
} from '../benchmarking/incremental-compaction/shared/consistency-utils.mjs';
import {
  DEFAULT_K,
  deleteDocuments,
  insertDocuments,
  makeBenchmarkDb,
} from '../benchmarking/incremental-compaction/shared/benchmark-utils.mjs';

describe('record to B+ tree consistency after incremental compaction', () => {
  it('keeps every indexed access path pointing at relocated records', async () => {
    const { db } = await makeBenchmarkDb();

    await insertDocuments(db, 'articles', 'free', 22, {
      payloadWords: 180,
      group: 'free',
      indexedFields: 4,
    });
    await insertDocuments(db, 'articles', 'tail', 28, {
      payloadWords: 180,
      group: 'tail',
      indexedFields: 4,
    });
    await insertDocuments(db, 'users', 'user', 12, {
      payloadWords: 70,
      group: 'active',
      indexedFields: 3,
    });
    await db.commit();

    await deleteDocuments(db, 'articles', 'free', 22);
    await db.commit();

    const before = await captureCrossStructureSnapshot(db);
    const stats = await db.getCompactionStorageStats();
    const boundary = Math.ceil(stats.usedBlocks * DEFAULT_K);
    const targets = await db.listRecordRelocationTargets(10);
    let relocated = 0;

    for (const target of targets) {
      if (target.collection === undefined || target.documentId === undefined || target.blockNumber === undefined) continue;
      const result = await db.relocateDocument(target.collection, target.documentId, {
        maxBlockExclusive: Math.min(boundary, target.blockNumber),
      });
      if (result.relocated) relocated++;
    }
    await db.commit();

    const after = await captureCrossStructureSnapshot(db);

    assert(relocated > 0);
    assertCrossStructureSnapshotsEqual(before, after);

    await db.close();
  });
});
