// @author: Alec Van Vlerken
// @date: 2026-05-08

import assert from 'assert';
import { describe, it } from 'vitest';

import {
  assertSemanticEquivalence,
  buildSemanticEquivalenceDataset,
  captureSemanticEquivalenceSnapshot,
  makeSemanticEquivalenceDb,
  reopenSemanticEquivalenceDb,
} from '../../../tests/helpers/semantic-equivalence.mjs';

describe('incremental compaction HNSW semantic equivalence', () => {
  it('preserves exact text and image semantic results after incremental compaction and reopen', async () => {
    const database = await makeSemanticEquivalenceDb();
    const { db } = database;

    await buildSemanticEquivalenceDataset(db, { fragmentation: true });
    const before = await captureSemanticEquivalenceSnapshot(db);

    const result = await db.compactIfNeeded({
      maxAmplification: 1.05,
      softAmplification: 1.05,
      targetBatchDocuments: 8,
      targetBatchUnits: 8,
      maxStepsPerRun: 30,
    });
    await db.commit();

    assert(result !== null);
    assert.strictEqual(result.didWork, true);
    assert((result.relocatedDocuments ?? 0) > 0);
    assert((result.relocatedHnswUnits ?? 0) > 0);

    const after = await captureSemanticEquivalenceSnapshot(db);
    assertSemanticEquivalence(before, after);

    const reopened = await reopenSemanticEquivalenceDb(database);
    const afterReopen = await captureSemanticEquivalenceSnapshot(reopened);
    assertSemanticEquivalence(before, afterReopen);

    await reopened.close();
  });
});
