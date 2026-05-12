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
    'incremental-performance',
    async (db) => {
      await insertDocuments(db, 'items', 'free', 70, {
        payloadWords: 180,
        group: 'free',
        indexedFields: 4,
        semanticText: 'semantic free performance',
      });
      await db.commit();
      await insertDocuments(db, 'items', 'tail', 70, {
        payloadWords: 180,
        group: 'tail',
        indexedFields: 4,
        semanticText: 'semantic tail performance',
      });
      await db.commit();
      await deleteDocuments(db, 'items', 'free', 70);
      await db.commit();
    },
    {
      hnsw: true,
      policy: { maxAmplification: DEFAULT_K, softAmplification: DEFAULT_K, targetBatchDocuments: 5, targetBatchUnits: 5 },
      maxSteps: 160,
      benchmarkQueries: true,
    },
  );

  assert(result.queryBefore !== undefined);
  assert(result.queryAfter !== undefined);
  assert(result.timeTakenMs > 0);
}

runIfMain(import.meta.url, main);
