// @author: Alec Van Vlerken
// @date: 2026-05-07

import assert from 'assert';

import { deleteDocuments, insertDocuments, runAndWriteScenario, runIfMain } from '../shared/benchmark-utils.mjs';

export async function main(): Promise<void> {
  const noOp = await runAndWriteScenario(
    'under-k-noop',
    async (db) => {
      await insertDocuments(db, 'items', 'tail', 12, { payloadWords: 60, group: 'tail' });
      await db.commit();
    },
    {
      policy: { maxAmplification: 10, softAmplification: 10, targetBatchDocuments: 2, targetBatchUnits: 2 },
      maxSteps: 4,
    },
  );
  assert.strictEqual(noOp.status, 'no-op');
  assert.strictEqual(noOp.stepsTaken, 1);

  const healthy = await runAndWriteScenario(
    'fragmented-but-already-healthy',
    async (db) => {
      await insertDocuments(db, 'items', 'free', 8, { payloadWords: 80, group: 'free' });
      await db.commit();
      await insertDocuments(db, 'items', 'tail', 40, { payloadWords: 80, group: 'tail' });
      await db.commit();
      await deleteDocuments(db, 'items', 'free', 8);
      await db.commit();
    },
    {
      policy: { maxAmplification: 3, softAmplification: 3, targetBatchDocuments: 2, targetBatchUnits: 2 },
      maxSteps: 4,
    },
  );
  assert.strictEqual(healthy.status, 'no-op');

  const plateau = await runAndWriteScenario(
    'no-further-safe-progress',
    async (db) => {
      await insertDocuments(db, 'items', 'tail', 16, { payloadWords: 60, group: 'tail' });
      await db.commit();
    },
    {
      policy: { maxAmplification: 0.5, softAmplification: 0.5, targetBatchDocuments: 2, targetBatchUnits: 2 },
      maxSteps: 6,
    },
  );
  assert.strictEqual(plateau.status, 'plateau-no-safe-progress');
}

runIfMain(import.meta.url, main);
