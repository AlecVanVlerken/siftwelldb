// @author: Alec Van Vlerken
// @date: 2026-05-08

import assert from 'assert';

import {
  deleteDocuments,
  insertDocuments,
  runAndWriteScenario,
  runIfMain,
} from '../shared/benchmark-utils.mjs';

export async function main(): Promise<void> {
  const explicitPlateau = await runAndWriteScenario(
    'no-further-safe-progress-explicit',
    async (db) => {
      await insertDocuments(db, 'items', 'live', 22, { payloadWords: 60, group: 'live', indexedFields: 1 });
      await db.commit();
    },
    {
      policy: { maxAmplification: 0.5, softAmplification: 0.5, targetBatchDocuments: 2, targetBatchUnits: 2 },
      maxSteps: 8,
    },
  );
  assert.strictEqual(explicitPlateau.status, 'plateau-no-safe-progress');
  assert(explicitPlateau.after.amplification > 0.5);

  const partial = await runAndWriteScenario(
    'partial-convergence-then-plateau',
    async (db) => {
      await insertDocuments(db, 'items', 'free', 24, { payloadWords: 160, group: 'free', indexedFields: 2 });
      await db.commit();
      await insertDocuments(db, 'items', 'tail', 24, { payloadWords: 160, group: 'tail', indexedFields: 2 });
      await db.commit();
      await deleteDocuments(db, 'items', 'free', 24);
      await db.commit();
    },
    {
      policy: { maxAmplification: 0.75, softAmplification: 0.75, targetBatchDocuments: 3, targetBatchUnits: 3 },
      maxSteps: 120,
    },
  );
  assert(partial.shrunkBlocks >= 0);
  assert(partial.status === 'plateau-no-safe-progress' || partial.status === 'budget-exhausted');
  assert(partial.after.amplification > 0.75);
}

runIfMain(import.meta.url, main);
