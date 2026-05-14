// @author: Alec Van Vlerken
// @date: 2026-05-07

import assert from 'assert';

import {
  deleteDocuments,
  insertDocuments,
  makeHnswConfig,
  runAndWriteScenario,
  runIfMain,
} from '../shared/benchmark-utils.mjs';

export async function main(): Promise<void> {
  const result = await runAndWriteScenario(
    'incremental-performance',
    async (db) => {
      await insertDocuments(db, 'filler', 'hole', 36, {
        payloadWords: 220,
        group: 'low-free-space',
        indexedFields: 2,
        skipSemanticIndex: true,
      });
      await db.commit();
      await insertDocuments(db, 'items', 'tail', 70, {
        payloadWords: 150,
        group: 'tail',
        indexedFields: 4,
        semanticText: 'semantic tail performance',
      });
      await insertDocuments(db, 'items', 'dead', 5, {
        payloadWords: 110,
        group: 'deleted',
        indexedFields: 3,
        semanticText: 'semantic deleted performance tombstone',
      });
      await db.commit();
      await deleteDocuments(db, 'items', 'dead', 5);
      await deleteDocuments(db, 'filler', 'hole', 36);
      await db.commit();
    },
    {
      hnsw: true,
      hnswConfig: makeHnswConfig({ dimension: 900, M: 4, maxStoredLevel: 4, efConstruction: 32, efSearch: 16 }),
      policy: {
        maxAmplification: 1.05,
        softAmplification: 1.05,
        targetBatchDocuments: 8,
        targetBatchUnits: 8,
      },
      maxSteps: 160,
      benchmarkQueries: true,
    },
  );

  assert(result.queryBefore !== undefined);
  assert(result.queryAfter !== undefined);
  assert(result.timeTakenMs > 0);
  assert(result.relocatedHnswUnits > 0);
  assert(result.reclaimedTailBlocks > 0);
}

runIfMain(import.meta.url, main);
