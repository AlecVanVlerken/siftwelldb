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
  deleteDocuments,
  insertDocuments,
  makeBenchmarkDb,
  makeHnswConfig,
  printScenarioResult,
  reopenBenchmarkDb,
  runIfMain,
  runIncrementalUntilStable,
  writeScenarioArtifacts,
} from '../shared/benchmark-utils.mjs';

export async function main(): Promise<void> {
  const scenario = 'record-hnsw-reference-stability';
  const benchmark = await makeBenchmarkDb({
    hnsw: true,
    hnswConfig: makeHnswConfig({ dimension: 900, M: 4, maxStoredLevel: 4, efConstruction: 32, efSearch: 16 }),
  });
  const { db } = benchmark;
  const semanticChecks: SemanticCheck[] = [
    { collection: 'articles', query: 'reference semantic tail article', k: 5 },
    { collection: 'articles', query: 'reference semantic alternate article', k: 5 },
    { collection: 'notes', query: 'reference semantic note', k: 4 },
  ];

  await insertDocuments(db, 'filler', 'hole', 18, {
    payloadWords: 260,
    group: 'low-free-space',
    indexedFields: 1,
    skipSemanticIndex: true,
  });
  await db.commit();

  await insertDocuments(db, 'articles', 'tail', 30, {
    payloadWords: 180,
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
  await insertDocuments(db, 'articles', 'dead', 3, {
    payloadWords: 120,
    group: 'deleted',
    indexedFields: 2,
    semanticText: 'reference semantic deleted tombstone',
  });
  await db.commit();
  await deleteDocuments(db, 'articles', 'dead', 3);
  await deleteDocuments(db, 'filler', 'hole', 18);
  await db.commit();

  const graphBefore = await db.inspectHnswGraphStructure('articles');
  assert(
    graphBefore.some((node) => node.deleted),
    'fixture must leave retained HNSW tombstones',
  );
  assert(
    !(await db.semanticSearch('articles', 'reference semantic deleted tombstone', 5)).some((doc) =>
      String(doc.getId()).startsWith('dead'),
    ),
  );

  const beforeSnapshot = await captureCrossStructureSnapshot(db, semanticChecks);
  const result = await runIncrementalUntilStable(
    db,
    scenario,
    { maxAmplification: 1.05, softAmplification: 1.05, targetBatchDocuments: 6, targetBatchUnits: 6 },
    140,
  );
  await db.commit();
  const afterSnapshot = await captureCrossStructureSnapshot(db, semanticChecks);
  const report = compareConsistencySnapshots(beforeSnapshot, afterSnapshot);

  assertCrossStructureCoreEqual(beforeSnapshot, afterSnapshot);
  assertSemanticResultsReadable(afterSnapshot);
  const graphAfter = await db.inspectHnswGraphStructure('articles');
  assert(
    graphAfter.some((node) => node.deleted),
    'incremental compaction must retain tombstone state',
  );
  assert(
    !(await db.semanticSearch('articles', 'reference semantic deleted tombstone', 5)).some((doc) =>
      String(doc.getId()).startsWith('dead'),
    ),
  );

  const reopened = await reopenBenchmarkDb(benchmark);
  const reopenedSnapshot = await captureCrossStructureSnapshot(reopened, semanticChecks);
  const reopenReport = assertCrossStructureSnapshotsEqual(afterSnapshot, reopenedSnapshot);
  assert(
    !(await reopened.semanticSearch('articles', 'reference semantic deleted tombstone', 5)).some((doc) =>
      String(doc.getId()).startsWith('dead'),
    ),
  );

  Object.assign(result, report, {
    postReopenChecksPassed:
      reopenReport.sameIds &&
      reopenReport.sameDocumentContents &&
      reopenReport.sameIndexedResults &&
      reopenReport.sameCursorResults &&
      reopenReport.sameSemanticResults &&
      reopenReport.semanticResultsReadable,
  });

  assert(result.relocatedDocuments > 0);
  assert(result.relocatedHnswUnits > 0);
  assert(result.reclaimedTailBlocks > 0);
  assert.strictEqual(report.sameDocumentContents, true);
  assert.strictEqual(report.sameSemanticResults, true);
  assert.strictEqual(report.semanticResultsReadable, true);
  assert.strictEqual(result.postReopenChecksPassed, true);

  await writeScenarioArtifacts(result);
  printScenarioResult(result);
  await reopened.close();
}

runIfMain(import.meta.url, main);
