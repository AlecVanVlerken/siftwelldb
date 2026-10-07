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
  const result = await runAndWriteScenario(
    'heavy-delete-shrink',
    async (db) => {
      await insertDocuments(db, 'items', 'free', 60, { payloadWords: 350, group: 'free' });
      await db.commit();
      await insertDocuments(db, 'items', 'tail', 40, { payloadWords: 350, group: 'tail' });
      await db.commit();
      await deleteDocuments(db, 'items', 'free', 60);
      await db.commit();
    },
    {
      policy: {
        maxAmplification: DEFAULT_K,
        softAmplification: DEFAULT_K,
        targetBatchDocuments: 6,
        targetBatchUnits: 6,
      },
      maxSteps: 120,
      benchmarkQueries: true,
    },
  );

  assert(result.shrunkBytes > 0);
}

runIfMain(import.meta.url, main);
