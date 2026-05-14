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
    'mixed-tail-blockers',
    async (db) => {
      await insertDocuments(db, 'filler', 'hole', 28, {
        payloadWords: 240,
        group: 'low-free-space',
        indexedFields: 3,
        skipSemanticIndex: true,
      });
      await db.commit();
      await insertDocuments(db, 'items', 'tail', 45, {
        payloadWords: 180,
        group: 'tail',
        indexedFields: 5,
        semanticText: 'semantic tail vector',
      });
      await insertDocuments(db, 'items', 'dead', 4, {
        payloadWords: 120,
        group: 'deleted',
        indexedFields: 3,
        semanticText: 'semantic deleted tombstone vector',
      });
      await db.commit();
      await deleteDocuments(db, 'items', 'dead', 4);
      await deleteDocuments(db, 'filler', 'hole', 28);
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

  assert(result.relocatedDocuments + result.relocatedBtreeNodes + result.relocatedHnswUnits > 0);
  assert(result.relocatedHnswUnits > 0);
  assert(result.shrunkBytes > 0);
}

runIfMain(import.meta.url, main);
