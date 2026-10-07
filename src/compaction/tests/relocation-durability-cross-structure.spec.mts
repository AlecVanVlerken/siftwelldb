// @author: Alec Van Vlerken
// @date: 2026-05-07

import assert from 'assert';
import { describe, it } from 'vitest';

import {
  assertCrossStructureCoreEqual,
  assertCrossStructureSnapshotsEqual,
  assertSemanticResultsReadable,
  captureCrossStructureSnapshot,
  strictConsistencyPolicy,
  type SemanticCheck,
} from '../../../benchmarks/incremental-compaction/shared/consistency-utils.mjs';
import {
  deleteDocuments,
  insertDocuments,
  makeBenchmarkDb,
  reopenBenchmarkDb,
} from '../../../benchmarks/incremental-compaction/shared/benchmark-utils.mjs';

describe('cross-structure relocation durability', () => {
  it('preserves record, B+ tree, and HNSW relationships after commit and reopen', async () => {
    const benchmark = await makeBenchmarkDb({ hnsw: true });
    const { db } = benchmark;
    const semanticChecks: SemanticCheck[] = [
      { collection: 'articles', query: 'durable semantic tail article', k: 5 },
      { collection: 'events', query: 'durable semantic event', k: 4 },
    ];

    await insertDocuments(db, 'articles', 'free', 18, {
      payloadWords: 210,
      group: 'free',
      indexedFields: 4,
      semanticText: 'durable semantic deleted article',
    });
    await insertDocuments(db, 'articles', 'tail', 24, {
      payloadWords: 210,
      group: 'tail',
      indexedFields: 4,
      semanticText: 'durable semantic tail article',
    });
    await insertDocuments(db, 'events', 'event', 14, {
      payloadWords: 90,
      group: 'live',
      indexedFields: 2,
      semanticText: 'durable semantic event',
    });
    await db.commit();

    await deleteDocuments(db, 'articles', 'free', 18);
    await db.commit();

    const before = await captureCrossStructureSnapshot(db, semanticChecks);
    const compaction = await db.compactIfNeeded(strictConsistencyPolicy);
    await db.commit();

    const compacted = await captureCrossStructureSnapshot(db, semanticChecks);
    assertCrossStructureCoreEqual(before, compacted);
    assertSemanticResultsReadable(compacted);

    const reopened = await reopenBenchmarkDb(benchmark);
    const reopenedSnapshot = await captureCrossStructureSnapshot(reopened, semanticChecks);
    const report = assertCrossStructureSnapshotsEqual(compacted, reopenedSnapshot);

    assert(compaction === null || compaction.didWork || compaction.blocked === true);
    assert.strictEqual(report.semanticResultsReadable, true);

    await reopened.close();
  });
});
