// @author: Alec Van Vlerken
// @date: 2026-05-08

import assert from 'assert';

import {
  deleteDocuments,
  insertDocuments,
  makeHnswConfig,
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
      await insertDocuments(db, 'filler', 'hole', 30, {
        payloadWords: 190,
        group: 'low-free-space',
        indexedFields: 2,
        skipSemanticIndex: true,
      });
      await db.commit();
      await insertDocuments(db, 'items', 'tail', 60, {
        payloadWords: 120,
        group: 'tail',
        indexedFields: 3,
        semanticText: 'heavy overhead tail semantic',
      });
      await insertDocuments(db, 'items', 'dead', 4, {
        payloadWords: 100,
        group: 'deleted',
        indexedFields: 2,
        semanticText: 'heavy overhead deleted tombstone',
      });
      await db.commit();
      await deleteDocuments(db, 'items', 'dead', 4);
      await deleteDocuments(db, 'filler', 'hole', 30);
      await db.commit();
    },
    {
      hnsw: true,
      hnswConfig: makeHnswConfig({ dimension: 900, M: 4, maxStoredLevel: 4, efConstruction: 32, efSearch: 16 }),
      policy: {
        maxAmplification: 1.05,
        softAmplification: 1.05,
        targetBatchDocuments: 6,
        targetBatchUnits: 6,
      },
      maxSteps: 160,
      benchmarkQueries: true,
    },
  );
  assert(heavy.timeTakenMs > 0);
  assert(heavy.status === 'converged' || heavy.status === 'plateau-no-safe-progress');
  assert(heavy.relocatedHnswUnits > 0);
  assert(heavy.reclaimedTailBlocks > 0);
}

runIfMain(import.meta.url, main);
