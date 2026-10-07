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
  const results = [];
  results.push(
    await runAndWriteScenario(
      'recordstore-only-shrink',
      async (db) => {
        await insertDocuments(db, 'items', 'free', 28, { payloadWords: 500, group: 'free' });
        await db.commit();
        await insertDocuments(db, 'items', 'tail', 28, { payloadWords: 500, group: 'tail' });
        await db.commit();
        await deleteDocuments(db, 'items', 'free', 28);
        await db.commit();
      },
      {
        policy: { maxAmplification: DEFAULT_K, softAmplification: DEFAULT_K, targetBatchDocuments: 4 },
        maxSteps: 100,
      },
    ),
  );
  results.push(
    await runAndWriteScenario(
      'large-record-chain',
      async (db) => {
        await insertDocuments(db, 'items', 'free', 12, { payloadWords: 1800, group: 'free' });
        await db.commit();
        await insertDocuments(db, 'items', 'tail', 12, { payloadWords: 1800, group: 'tail' });
        await db.commit();
        await deleteDocuments(db, 'items', 'free', 12);
        await db.commit();
      },
      {
        policy: { maxAmplification: DEFAULT_K, softAmplification: DEFAULT_K, targetBatchDocuments: 2 },
        maxSteps: 100,
      },
    ),
  );
  results.push(
    await runAndWriteScenario(
      'head-low-tail-high-record',
      async (db) => {
        await insertDocuments(db, 'items', 'free', 5, { payloadWords: 2200, group: 'free' });
        await db.commit();
        await insertDocuments(db, 'items', 'tail', 3, { payloadWords: 3600, group: 'tail' });
        await db.commit();
        await deleteDocuments(db, 'items', 'free', 5);
        await db.commit();
      },
      {
        policy: { maxAmplification: DEFAULT_K, softAmplification: DEFAULT_K, targetBatchDocuments: 1 },
        maxSteps: 80,
      },
    ),
  );
  assert(results.some((result) => result.relocatedDocuments > 0));
  assert(results.some((result) => result.shrunkBytes > 0));
}

runIfMain(import.meta.url, main);
