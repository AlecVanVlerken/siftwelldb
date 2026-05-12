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
    'mixed-tail-blockers',
    async (db) => {
      await insertDocuments(db, 'items', 'free', 35, {
        payloadWords: 220,
        group: 'free',
        indexedFields: 5,
        semanticText: 'semantic free vector',
      });
      await db.commit();
      await insertDocuments(db, 'items', 'tail', 45, {
        payloadWords: 220,
        group: 'tail',
        indexedFields: 5,
        semanticText: 'semantic tail vector',
      });
      await db.commit();
      await deleteDocuments(db, 'items', 'free', 35);
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

  assert(result.relocatedDocuments + result.relocatedBtreeNodes + result.relocatedHnswUnits > 0);
  assert(result.shrunkBytes >= 0);
}

runIfMain(import.meta.url, main);
