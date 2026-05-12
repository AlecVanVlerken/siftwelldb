// @author: Alec Van Vlerken
// @date: 2026-05-08

import { describe, it } from 'vitest';

import { MockFile } from '../core/mockfile.mjs';
import { DbmsBack } from '../dbms/dbmsback.mjs';
import { vacuumCompactInto } from './compaction.mjs';
import {
  assertSemanticEquivalence,
  buildSemanticEquivalenceDataset,
  captureSemanticEquivalenceSnapshot,
  makeSemanticEquivalenceDb,
} from './hnsw-semantic-equivalence-utils.mjs';

describe('full vacuum HNSW semantic equivalence', () => {
  it('preserves exact text and image semantic results after vacuum and reopen', async () => {
    const source = await makeSemanticEquivalenceDb();
    await buildSemanticEquivalenceDataset(source.db, { fragmentation: true });
    const before = await captureSemanticEquivalenceSnapshot(source.db);

    const tempData = new MockFile(4096);
    const tempLog = new MockFile(4096);
    const result = await vacuumCompactInto({
      source: source.db,
      tempDataFile: tempData,
      tempLogFile: tempLog,
      validate: true,
      rebuildHnsw: true,
    });

    const afterVacuum = await captureSemanticEquivalenceSnapshot(result.target);
    assertSemanticEquivalence(before, afterVacuum);

    await result.target.commit();
    await result.target.close();
    const reopened = await DbmsBack.open(tempData, tempLog, source.hnswConfig);
    const afterReopen = await captureSemanticEquivalenceSnapshot(reopened);
    assertSemanticEquivalence(before, afterReopen);

    await reopened.close();
    await source.db.close();
  });
});
