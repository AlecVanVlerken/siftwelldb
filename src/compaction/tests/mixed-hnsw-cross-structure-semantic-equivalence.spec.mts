// @author: Alec Van Vlerken
// @date: 2026-05-08

import assert from 'assert';
import { describe, it } from 'vitest';

import {
  assertCrossStructureCoreEqual,
  captureCrossStructureSnapshot,
} from '../../../benchmarks/incremental-compaction/shared/consistency-utils.mjs';
import {
  assertSemanticEquivalence,
  buildSemanticEquivalenceDataset,
  captureSemanticEquivalenceSnapshot,
  makeSemanticEquivalenceDb,
  reopenSemanticEquivalenceDb,
  semanticTextQueries,
} from '../../../tests/helpers/semantic-equivalence.mjs';

describe('mixed HNSW cross-structure semantic equivalence', () => {
  it('preserves exact semantic results and indexed access paths after mixed incremental compaction and reopen', async () => {
    const database = await makeSemanticEquivalenceDb();
    const { db } = database;

    await buildSemanticEquivalenceDataset(db, { fragmentation: true });

    const beforeCore = await captureCrossStructureSnapshot(db, semanticTextQueries);
    const beforeSemantic = await captureSemanticEquivalenceSnapshot(db);

    const result = await db.compactIfNeeded({
      maxAmplification: 1.05,
      softAmplification: 1.05,
      targetBatchDocuments: 6,
      targetBatchUnits: 6,
      maxStepsPerRun: 30,
    });
    await db.commit();

    assert(result !== null);
    assert.strictEqual(result.didWork, true);
    assert((result.relocatedDocuments ?? 0) > 0);
    assert((result.relocatedBtreeNodes ?? 0) > 0);
    assert((result.relocatedHnswUnits ?? 0) > 0);

    const afterCore = await captureCrossStructureSnapshot(db, semanticTextQueries);
    const afterSemantic = await captureSemanticEquivalenceSnapshot(db);
    assertCrossStructureCoreEqual(beforeCore, afterCore);
    assertSemanticEquivalence(beforeSemantic, afterSemantic);

    const reopened = await reopenSemanticEquivalenceDb(database);
    const afterReopenCore = await captureCrossStructureSnapshot(reopened, semanticTextQueries);
    const afterReopenSemantic = await captureSemanticEquivalenceSnapshot(reopened);
    assertCrossStructureCoreEqual(beforeCore, afterReopenCore);
    assertSemanticEquivalence(beforeSemantic, afterReopenSemantic);

    await reopened.close();
  });
});
