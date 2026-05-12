// @author: Alec Van Vlerken
// @date: 2026-05-07

import {
  DEFAULT_K,
  deleteDocuments,
  insertDocuments,
  runAndWriteScenario,
  runIfMain,
} from '../shared/benchmark-utils.mjs';

export async function main(): Promise<void> {
  await runAndWriteScenario(
    'k-convergence',
    async (db) => {
      await insertDocuments(db, 'items', 'free', 20, { payloadWords: 800, group: 'free' });
      await db.commit();
      await insertDocuments(db, 'items', 'tail', 20, { payloadWords: 800, group: 'tail' });
      await db.commit();
      await deleteDocuments(db, 'items', 'free', 20);
      await db.commit();
    },
    {
      policy: {
        maxAmplification: DEFAULT_K,
        softAmplification: DEFAULT_K,
        targetBatchDocuments: 4,
        targetBatchUnits: 4,
      },
      maxSteps: 80,
      assertConverged: true,
      benchmarkQueries: true,
    },
  );
}

runIfMain(import.meta.url, main);
