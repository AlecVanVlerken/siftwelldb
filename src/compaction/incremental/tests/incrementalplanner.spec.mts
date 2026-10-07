import assert from 'assert';
import { describe, it } from 'vitest';

import { MockFile } from '../../../../tests/helpers/mockfile.mjs';
import { DbmsBack } from '../../../database/dbmsback.mjs';
import { JSONtoDocument } from '../../../database/document.mjs';
import { planIncrementalCompactionStep } from '../../compaction.mjs';
import { CompactionPolicy } from '../compactionpolicy.mjs';
import { CompactionState } from '../compactionstate.mjs';
import { IncrementalPlanner } from '../incrementalplanner.mjs';

async function makeDb(): Promise<DbmsBack> {
  const db = new DbmsBack(new MockFile(4096), new MockFile(4096));
  await db.create();
  return db;
}

describe('IncrementalPlanner', () => {
  it('returns null when policy does not request compaction', async () => {
    const db = await makeDb();

    const batch = await planIncrementalCompactionStep(db, { maxAmplification: 10 });

    assert.strictEqual(batch, null);
  });

  it('returns a bounded record batch when compaction is needed', async () => {
    const db = await makeDb();
    for (const doc of [
      { id: 'a1', title: 'alpha' },
      { id: 'a2', title: 'beta' },
      { id: 'a3', title: 'gamma' },
    ]) {
      await db.insertDocument(JSONtoDocument(JSON.stringify(doc), 'articles'));
    }
    await db.commit();

    const state = new CompactionState();
    const planner = new IncrementalPlanner(
      db,
      new CompactionPolicy({ maxAmplification: 0.5, targetBatchDocuments: 2 }),
      state,
    );
    const batch = await planner.plan();

    assert(batch);
    assert(batch.targets.length > 0);
    assert(batch.targets.length <= 2);
    assert(batch.targets.every((target) => target.kind === 'record'));
    assert(state.getLastRecordCursor().collection);
  });

  it('returns tail reclamation when a free suffix exists and no high live target blocks it', async () => {
    const db = await makeDb();
    await db.insertDocument(JSONtoDocument(JSON.stringify({ id: 'keep', title: 'kept' }), 'articles'));
    await db.commit();
    await db.insertDocument(JSONtoDocument(JSON.stringify({ id: 'drop', title: 'tail' }), 'articles'));
    await db.commit();
    await db.deleteDocument('drop', 'articles');
    await db.commit();

    const batch = await planIncrementalCompactionStep(db, { maxAmplification: 10 });

    assert(batch);
    assert.strictEqual(batch.targets.length, 1);
    assert.strictEqual(batch.targets[0].kind, 'tail-reclaim');
  });

  it('does not emit targets without a relocation kind', async () => {
    const db = await makeDb();
    await db.insertDocument(JSONtoDocument(JSON.stringify({ id: 'a1', title: 'alpha' }), 'articles'));
    await db.commit();

    const batch = await planIncrementalCompactionStep(db, { maxAmplification: 0.5, targetBatchUnits: 4 });

    assert(batch);
    assert(batch.targets.every((target) => typeof target.kind === 'string'));
  });
});
