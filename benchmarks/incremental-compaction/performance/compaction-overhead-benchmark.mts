// @author: Alec Van Vlerken
// @date: 2026-05-08

import assert from 'assert';

import {
  DEFAULT_K,
  deleteDocuments,
  insertDocuments,
  runAndWriteScenario,
  runIfMain,
} from '../shared/benchmark-utils.mjs';

export async function main(): Promise<void> {
  const light = await runAndWriteScenario(
    'compaction-overhead-light-churn',
    async (db) => {
      await insertDocuments(db, 'items', 'light', 20, { payloadWords: 45, group: 'light', indexedFields: 1 });
      await db.commit();
      await insertDocuments(db, 'items', 'smallfree', 4, { payloadWords: 45, group: 'smallfree', indexedFields: 1 });
      await db.commit();
      await deleteDocuments(db, 'items', 'smallfree', 4);
      await db.commit();
    },
    {
      policy: { maxAmplification: 3, softAmplification: 3, targetBatchDocuments: 2, targetBatchUnits: 2 },
      maxSteps: 6,
      benchmarkQueries: true,
    },
  );
  assert(light.status === 'no-op' || light.stepsTaken <= 2);

  const heavy = await runAndWriteScenario(
    'compaction-overhead-heavy-churn',
    async (db) => {
      await insertDocuments(db, 'items', 'free', 60, {
        payloadWords: 140,
        group: 'free',
        indexedFields: 3,
        semanticText: 'heavy overhead free semantic',
      });
      await db.commit();
      await insertDocuments(db, 'items', 'tail', 60, {
        payloadWords: 140,
        group: 'tail',
        indexedFields: 3,
        semanticText: 'heavy overhead tail semantic',
      });
      await db.commit();
      await deleteDocuments(db, 'items', 'free', 60);
      await db.commit();
    },
    {
      hnsw: true,
      policy: {
        maxAmplification: DEFAULT_K,
        softAmplification: DEFAULT_K,
        targetBatchDocuments: 4,
        targetBatchUnits: 4,
      },
      maxSteps: 160,
      benchmarkQueries: true,
    },
  );
  assert(heavy.timeTakenMs > 0);
  assert(heavy.status === 'converged' || heavy.status === 'plateau-no-safe-progress');
}

runIfMain(import.meta.url, main);
