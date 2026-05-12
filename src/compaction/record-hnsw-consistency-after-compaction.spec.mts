// @author: Alec Van Vlerken
// @date: 2026-05-07

import assert from 'assert';
import { describe, it } from 'vitest';

import {
  assertCrossStructureCoreEqual,
  assertCrossStructureSnapshotsEqual,
  assertSemanticResultsReadable,
  captureCrossStructureSnapshot,
  type SemanticCheck,
} from '../benchmarking/incremental-compaction/shared/consistency-utils.mjs';
import {
  DEFAULT_K,
  deleteDocuments,
  insertDocuments,
  makeBenchmarkDb,
} from '../benchmarking/incremental-compaction/shared/benchmark-utils.mjs';

describe('record to HNSW consistency after incremental compaction', () => {
  it('keeps semantic search resolving to readable relocated records', async () => {
    const { db } = await makeBenchmarkDb({ hnsw: true });
    const semanticChecks: SemanticCheck[] = [
      { collection: 'articles', query: 'semantic alpha topic tail', k: 4 },
      { collection: 'articles', query: 'semantic beta topic tail', k: 4 },
      { collection: 'notes', query: 'semantic notes tail', k: 3 },
    ];

    await insertDocuments(db, 'articles', 'free', 14, {
      payloadWords: 210,
      group: 'free',
      indexedFields: 2,
      semanticText: 'semantic deleted topic',
    });
    await insertDocuments(db, 'articles', 'tail', 22, {
      payloadWords: 210,
      group: 'tail',
      indexedFields: 2,
      semanticText: 'semantic alpha topic tail',
    });
    await insertDocuments(db, 'notes', 'note', 10, {
      payloadWords: 90,
      group: 'tail',
      indexedFields: 1,
      semanticText: 'semantic notes tail',
    });
    await db.commit();

    await deleteDocuments(db, 'articles', 'free', 14);
    await db.commit();

    const before = await captureCrossStructureSnapshot(db, semanticChecks);
    const stats = await db.getCompactionStorageStats();
    const boundary = Math.ceil(stats.usedBlocks * DEFAULT_K);
    const targets = await db.listRecordRelocationTargets(8);
    let relocated = 0;

    for (const target of targets) {
      if (target.collection === undefined || target.documentId === undefined || target.blockNumber === undefined)
        continue;
      const result = await db.relocateDocument(target.collection, target.documentId, {
        maxBlockExclusive: Math.min(boundary, target.blockNumber),
      });
      if (result.relocated) relocated++;
    }
    await db.commit();

    const after = await captureCrossStructureSnapshot(db, semanticChecks);

    assert(relocated > 0);
    assertCrossStructureCoreEqual(before, after);
    assertCrossStructureSnapshotsEqual(before, after);
    assertSemanticResultsReadable(after);

    await db.close();
  });
});
