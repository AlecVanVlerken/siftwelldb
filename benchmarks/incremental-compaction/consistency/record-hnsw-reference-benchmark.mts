// @author: Alec Van Vlerken
// @date: 2026-05-07

import assert from 'assert';

import {
  assertCrossStructureCoreEqual,
  assertSemanticResultsReadable,
  captureCrossStructureSnapshot,
  compareConsistencySnapshots,
  type SemanticCheck,
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
  const scenario = 'record-hnsw-reference-stability';
  const { db } = await makeBenchmarkDb({ hnsw: true });
  const semanticChecks: SemanticCheck[] = [
    { collection: 'articles', query: 'reference semantic tail article', k: 5 },
    { collection: 'articles', query: 'reference semantic alternate article', k: 5 },
    { collection: 'notes', query: 'reference semantic note', k: 4 },
  ];

  await insertDocuments(db, 'articles', 'free', 22, {
    payloadWords: 250,
    group: 'free',
    indexedFields: 2,
    semanticText: 'reference semantic deleted article',
  });
  await insertDocuments(db, 'articles', 'tail', 30, {
    payloadWords: 250,
    group: 'tail',
    indexedFields: 2,
    semanticText: 'reference semantic tail article',
  });
  await insertDocuments(db, 'notes', 'note', 12, {
    payloadWords: 100,
    group: 'live',
    indexedFields: 1,
    semanticText: 'reference semantic note',
  });
  await db.commit();
  await deleteDocuments(db, 'articles', 'free', 22);
  await db.commit();

  const beforeSnapshot = await captureCrossStructureSnapshot(db, semanticChecks);
  const result = await runIncrementalUntilStable(
    db,
    scenario,
    { maxAmplification: DEFAULT_K, softAmplification: DEFAULT_K, targetBatchDocuments: 5, targetBatchUnits: 4 },
    90,
  );
  await db.commit();
  const afterSnapshot = await captureCrossStructureSnapshot(db, semanticChecks);
  const report = compareConsistencySnapshots(beforeSnapshot, afterSnapshot);

  assertCrossStructureCoreEqual(beforeSnapshot, afterSnapshot);
  assertSemanticResultsReadable(afterSnapshot);
  Object.assign(result, report);

  assert(result.relocatedDocuments > 0);
  assert.strictEqual(report.sameDocumentContents, true);
  assert.strictEqual(report.sameSemanticResults, true);
  assert.strictEqual(report.semanticResultsReadable, true);

  await writeScenarioArtifacts(result);
  printScenarioResult(result);
  await db.close();
}

runIfMain(import.meta.url, main);
