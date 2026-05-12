// @author: Alec Van Vlerken
// @date: 2026-05-07

import assert from 'assert';

import {
  DEFAULT_K,
  deleteDocuments,
  insertDocuments,
  runAndWriteScenario,
  runIfMain,
} from '../shared/benchmark-utils.mjs';

export async function main(): Promise<void> {
  const bounded = await runAndWriteScenario(
    'bounded-step-idle',
    async (db) => {
      await insertDocuments(db, 'items', 'free', 30, { payloadWords: 360, group: 'free' });
      await db.commit();
      await insertDocuments(db, 'items', 'tail', 30, { payloadWords: 360, group: 'tail' });
      await db.commit();
      await deleteDocuments(db, 'items', 'free', 30);
      await db.commit();
    },
    {
      policy: { maxAmplification: DEFAULT_K, softAmplification: DEFAULT_K, targetBatchDocuments: 1, targetBatchUnits: 1 },
      maxSteps: 120,
    },
  );

  assert(bounded.stepsTaken > 1);
  assert(bounded.history.every((step) => step.timeMs < 100));

  await runAndWriteScenario(
    'repeated-idle-steps',
    async (db) => {
      await insertDocuments(db, 'items', 'free', 24, { payloadWords: 420, group: 'free' });
      await db.commit();
      await insertDocuments(db, 'items', 'tail', 24, { payloadWords: 420, group: 'tail' });
      await db.commit();
      await deleteDocuments(db, 'items', 'free', 24);
      await db.commit();
    },
    {
      policy: { maxAmplification: DEFAULT_K, softAmplification: DEFAULT_K, targetBatchDocuments: 2, targetBatchUnits: 2 },
      maxSteps: 120,
    },
  );
}

runIfMain(import.meta.url, main);
