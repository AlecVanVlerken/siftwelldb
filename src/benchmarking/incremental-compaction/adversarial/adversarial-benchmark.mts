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
  const alternating = await runAndWriteScenario(
    'alternating-tail-layout',
    async (db) => {
      await insertDocuments(db, 'items', 'hole', 24, { payloadWords: 160, group: 'hole' });
      await db.commit();
      for (let i = 0; i < 18; i++) {
        await insertDocuments(db, 'items', `live${i.toString().padStart(2, '0')}`, 1, {
          payloadWords: 120,
          group: 'tail',
        });
        await insertDocuments(db, 'items', `dead${i.toString().padStart(2, '0')}`, 1, {
          payloadWords: 120,
          group: 'dead',
        });
      }
      await db.commit();
      await deleteDocuments(db, 'items', 'hole', 24);
      for (let i = 0; i < 18; i++) await deleteDocuments(db, 'items', `dead${i.toString().padStart(2, '0')}`, 1);
      await db.commit();
    },
    {
      policy: { maxAmplification: DEFAULT_K, softAmplification: DEFAULT_K, targetBatchDocuments: 2, targetBatchUnits: 2 },
      maxSteps: 160,
    },
  );
  assert(alternating.shrunkBytes >= 0);

  const oneBlocker = await runAndWriteScenario(
    'one-small-blocker-huge-tail',
    async (db) => {
      await insertDocuments(db, 'items', 'hole', 35, { payloadWords: 120, group: 'hole' });
      await db.commit();
      await insertDocuments(db, 'items', 'tail', 1, { payloadWords: 20, group: 'tail' });
      await db.commit();
      await insertDocuments(db, 'items', 'trash', 35, { payloadWords: 120, group: 'trash' });
      await db.commit();
      await deleteDocuments(db, 'items', 'hole', 35);
      await deleteDocuments(db, 'items', 'trash', 35);
      await db.commit();
    },
    {
      policy: { maxAmplification: DEFAULT_K, softAmplification: DEFAULT_K, targetBatchDocuments: 1, targetBatchUnits: 1 },
      maxSteps: 80,
    },
  );
  assert(oneBlocker.shrunkBytes > 0);

  const manyBlockers = await runAndWriteScenario(
    'many-small-blockers',
    async (db) => {
      await insertDocuments(db, 'items', 'hole', 40, { payloadWords: 100, group: 'hole' });
      await db.commit();
      await insertDocuments(db, 'items', 'tail', 35, { payloadWords: 80, group: 'tail' });
      await db.commit();
      await deleteDocuments(db, 'items', 'hole', 40);
      await db.commit();
    },
    {
      policy: { maxAmplification: DEFAULT_K, softAmplification: DEFAULT_K, targetBatchDocuments: 1, targetBatchUnits: 1 },
      maxSteps: 120,
    },
  );
  assert(manyBlockers.stepsTaken > 1);
}

runIfMain(import.meta.url, main);
