// @author: Alec Van Vlerken
// @date: 2026-05-07

import assert from 'assert';

import {
  assertCrossStructureCoreEqual,
  assertCrossStructureSnapshotsEqual,
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
  reopenBenchmarkDb,
  runIfMain,
  runIncrementalUntilStable,
  writeScenarioArtifacts,
} from '../shared/benchmark-utils.mjs';

export async function main(): Promise<void> {
  const scenario = 'mixed-cross-structure-durability';
  const benchmark = await makeBenchmarkDb({ hnsw: true });
  const { db } = benchmark;
  const semanticChecks: SemanticCheck[] = [
    { collection: 'articles', query: 'benchmark semantic tail article', k: 5 },
    { collection: 'events', query: 'benchmark semantic event', k: 4 },
  ];

  await insertDocuments(db, 'articles', 'free', 24, {
    payloadWords: 230,
    group: 'free',
    indexedFields: 4,
    semanticText: 'benchmark semantic deleted article',
  });
  await insertDocuments(db, 'articles', 'tail', 32, {
    payloadWords: 230,
    group: 'tail',
    indexedFields: 4,
    semanticText: 'benchmark semantic tail article',
  });
  await insertDocuments(db, 'events', 'event', 16, {
    payloadWords: 90,
    group: 'live',
    indexedFields: 3,
    semanticText: 'benchmark semantic event',
  });
  await insertDocuments(db, 'users', 'user', 12, {
    payloadWords: 70,
    group: 'active',
    indexedFields: 2,
  });
  await db.commit();
  await deleteDocuments(db, 'articles', 'free', 24);
  await db.commit();

  const beforeSnapshot = await captureCrossStructureSnapshot(db, semanticChecks);
  const result = await runIncrementalUntilStable(
    db,
    scenario,
    { maxAmplification: DEFAULT_K, softAmplification: DEFAULT_K, targetBatchDocuments: 5, targetBatchUnits: 5 },
    100,
  );
  await db.commit();

  const compactedSnapshot = await captureCrossStructureSnapshot(db, semanticChecks);
  const compactionReport = compareConsistencySnapshots(beforeSnapshot, compactedSnapshot);
  assertCrossStructureCoreEqual(beforeSnapshot, compactedSnapshot);
  assertSemanticResultsReadable(compactedSnapshot);

  const reopened = await reopenBenchmarkDb(benchmark);
  const reopenedSnapshot = await captureCrossStructureSnapshot(reopened, semanticChecks);
  const reopenReport = assertCrossStructureSnapshotsEqual(compactedSnapshot, reopenedSnapshot);

  Object.assign(result, compactionReport, {
    postReopenChecksPassed:
      reopenReport.sameIds &&
      reopenReport.sameDocumentContents &&
      reopenReport.sameIndexedResults &&
      reopenReport.sameCursorResults &&
      reopenReport.sameSemanticResults &&
      reopenReport.semanticResultsReadable,
  });

  assert(result.relocatedDocuments > 0 || result.relocatedBtreeNodes > 0 || result.relocatedHnswUnits > 0);
  assert.strictEqual(result.postReopenChecksPassed, true);

  await writeScenarioArtifacts(result);
  printScenarioResult(result);
  await reopened.close();
}

runIfMain(import.meta.url, main);
