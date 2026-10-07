// @author: Alec Van Vlerken
// @date: 2026-05-07

import assert from 'assert';
import { describe, it } from 'vitest';

import {
  assertCrossStructureSnapshotsEqual,
  captureCrossStructureSnapshot,
  strictConsistencyPolicy,
  type SemanticCheck,
} from '../../../benchmarks/incremental-compaction/shared/consistency-utils.mjs';
import {
  DEFAULT_K,
  deleteDocuments,
  insertDocuments,
  makeBenchmarkDb,
} from '../../../benchmarks/incremental-compaction/shared/benchmark-utils.mjs';

describe('mixed cross-structure consistency after incremental compaction', () => {
  it('preserves records, B+ tree indexes, cursors, HNSW results, and result resolution together', async () => {
    const { db } = await makeBenchmarkDb({ hnsw: true });
    const semanticChecks: SemanticCheck[] = [
      { collection: 'articles', query: 'mixed semantic tail article', k: 5 },
      { collection: 'logs', query: 'mixed semantic live log', k: 4 },
    ];

    await insertDocuments(db, 'articles', 'old', 16, {
      payloadWords: 180,
      group: 'old',
      indexedFields: 4,
      semanticText: 'mixed semantic deleted article',
    });
    await insertDocuments(db, 'articles', 'tail', 24, {
      payloadWords: 180,
      group: 'tail',
      indexedFields: 4,
      semanticText: 'mixed semantic tail article',
    });
    await insertDocuments(db, 'logs', 'log', 18, {
      payloadWords: 70,
      group: 'live',
      indexedFields: 3,
      semanticText: 'mixed semantic live log',
    });
    await insertDocuments(db, 'users', 'user', 12, {
      payloadWords: 60,
      group: 'active',
      indexedFields: 2,
    });
    await db.commit();

    await deleteDocuments(db, 'articles', 'old', 16);
    await db.commit();

    const before = await captureCrossStructureSnapshot(db, semanticChecks);
    const compacted = await db.compactIfNeeded(strictConsistencyPolicy);
    await db.commit();

    const stats = await db.getCompactionStorageStats();
    const boundary = Math.ceil(stats.usedBlocks * DEFAULT_K);
    const btreeTarget = (await db.listBtreeRelocationTargets(40)).find(
      (target) => target.collection !== undefined && target.field !== undefined && target.blockNumber !== undefined,
    );
    if (
      btreeTarget?.collection !== undefined &&
      btreeTarget.field !== undefined &&
      btreeTarget.blockNumber !== undefined
    ) {
      await db.relocateBtreeNode(btreeTarget.collection, btreeTarget.field, btreeTarget.blockNumber, {
        maxBlockExclusive: Math.min(boundary, btreeTarget.blockNumber),
      });
    }

    const hnswTarget = (await db.listHnswRelocationTargets('articles')).find(
      (target) => target.nodeId !== undefined && target.blockNumber !== undefined,
    );
    if (hnswTarget?.nodeId !== undefined && hnswTarget.blockNumber !== undefined) {
      await db.relocateHnswUnit({
        ...hnswTarget,
        maxBlockExclusive: Math.min(boundary, hnswTarget.blockNumber),
      });
    }
    await db.commit();

    const after = await captureCrossStructureSnapshot(db, semanticChecks);

    assert(compacted === null || compacted.didWork || compacted.blocked === true);
    assert(btreeTarget !== undefined);
    assert(hnswTarget !== undefined);
    assertCrossStructureSnapshotsEqual(before, after);

    await db.close();
  });
});
