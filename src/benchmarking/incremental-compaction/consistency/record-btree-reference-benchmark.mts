// @author: Alec Van Vlerken
// @date: 2026-05-07

import assert from 'assert';

import {
  assertCrossStructureSnapshotsEqual,
  captureCrossStructureSnapshot,
} from '../shared/consistency-utils.mjs';
import {
  DEFAULT_K,
  deleteDocuments,
  insertDocuments,
  makeBenchmarkDb,
  printScenarioResult,
  runIfMain,
  runIncrementalUntilStable,
  writeScenarioArtifacts,
} from '../shared/benchmark-utils.mjs';

export async function main(): Promise<void> {
  const scenario = 'record-btree-reference-stability';
  const { db } = await makeBenchmarkDb();

  await insertDocuments(db, 'articles', 'free', 34, {
    payloadWords: 260,
    group: 'free',
    indexedFields: 5,
  });
  await insertDocuments(db, 'articles', 'tail', 36, {
    payloadWords: 260,
    group: 'tail',
    indexedFields: 5,
  });
  await insertDocuments(db, 'users', 'user', 14, {
    payloadWords: 80,
    group: 'active',
    indexedFields: 3,
  });
  await db.commit();
  await deleteDocuments(db, 'articles', 'free', 34);
  await db.commit();

  const beforeSnapshot = await captureCrossStructureSnapshot(db);
  const result = await runIncrementalUntilStable(
    db,
    scenario,
    { maxAmplification: DEFAULT_K, softAmplification: DEFAULT_K, targetBatchDocuments: 6, targetBatchUnits: 4 },
    80,
  );
  await db.commit();
  const afterSnapshot = await captureCrossStructureSnapshot(db);
  const report = assertCrossStructureSnapshotsEqual(beforeSnapshot, afterSnapshot);
  Object.assign(result, report);

  assert(result.relocatedDocuments > 0);
  assert.strictEqual(report.sameIndexedResults, true);
  assert.strictEqual(report.sameCursorResults, true);

  await writeScenarioArtifacts(result);
  printScenarioResult(result);
  await db.close();
}

runIfMain(import.meta.url, main);
