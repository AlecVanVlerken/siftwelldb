// @author: Alec Van Vlerken
// @date: 2026-05-07

import assert from 'assert';

import {
  DEFAULT_K,
  deleteDocuments,
  editDocuments,
  insertDocuments,
  runAndWriteScenario,
  runIfMain,
} from '../shared/benchmark-utils.mjs';

export async function main(): Promise<void> {
  const result = await runAndWriteScenario(
    'mixed-churn-shrink',
    async (db) => {
      await insertDocuments(db, 'items', 'free', 30, { payloadWords: 300, group: 'free', indexedFields: 3 });
      await insertDocuments(db, 'users', 'olduser', 20, { payloadWords: 80, group: 'old', indexedFields: 2 });
      await db.commit();

      await insertDocuments(db, 'items', 'tail', 30, { payloadWords: 300, group: 'tail', indexedFields: 3 });
      await insertDocuments(db, 'logs', 'tailLog', 60, { payloadWords: 40, group: 'tail-log', indexedFields: 1 });
      await db.commit();

      await editDocuments(db, 'items', 'tail', 10);
      await deleteDocuments(db, 'items', 'free', 30);
      await deleteDocuments(db, 'users', 'olduser', 20);
      await insertDocuments(db, 'users', 'newuser', 10, { payloadWords: 60, group: 'new', indexedFields: 2 });
      await db.commit();
    },
    {
      policy: {
        maxAmplification: DEFAULT_K,
        softAmplification: DEFAULT_K,
        targetBatchDocuments: 5,
        targetBatchUnits: 5,
      },
      maxSteps: 120,
      benchmarkQueries: true,
    },
  );

  assert(result.shrunkBytes >= 0);
  assert(result.status === 'converged' || result.status === 'plateau-no-safe-progress');
}

runIfMain(import.meta.url, main);
