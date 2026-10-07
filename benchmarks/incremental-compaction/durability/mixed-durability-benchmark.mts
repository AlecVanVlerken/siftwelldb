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
  const scenario = 'mixed-cross-structure-durability';
  const benchmark = await makeBenchmarkDb({
    hnsw: true,
    hnswConfig: makeHnswConfig({ dimension: 900, M: 4, maxStoredLevel: 4, efConstruction: 32, efSearch: 16 }),
  });
  const { db } = benchmark;
  const semanticChecks: SemanticCheck[] = [
    { collection: 'articles', query: 'benchmark semantic tail article', k: 5 },
    { collection: 'events', query: 'benchmark semantic event', k: 4 },
  ];

  await insertDocuments(db, 'filler', 'hole', 22, {
    payloadWords: 250,
    group: 'low-free-space',
    indexedFields: 2,
    skipSemanticIndex: true,
  });
  await db.commit();

  await insertDocuments(db, 'articles', 'tail', 32, {
    payloadWords: 170,
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
  await insertDocuments(db, 'articles', 'dead', 4, {
    payloadWords: 120,
    group: 'deleted',
    indexedFields: 3,
    semanticText: 'benchmark semantic deleted tombstone',
  });
  await db.commit();
  await deleteDocuments(db, 'articles', 'dead', 4);
  await deleteDocuments(db, 'filler', 'hole', 22);
  await db.commit();

  const graphBefore = await db.inspectHnswGraphStructure('articles');
  assert(
    graphBefore.some((node) => node.deleted),
    'durability fixture must retain HNSW tombstones',
  );
  assert(
    !(await db.semanticSearch('articles', 'benchmark semantic deleted tombstone', 5)).some((doc) =>
      String(doc.getId()).startsWith('dead'),
    ),
  );

  const beforeSnapshot = await captureCrossStructureSnapshot(db, semanticChecks);
  const result = await runIncrementalUntilStable(
    db,
    scenario,
    { maxAmplification: 1.05, softAmplification: 1.05, targetBatchDocuments: 6, targetBatchUnits: 6 },
    150,
  );
  await db.commit();

  const compactedSnapshot = await captureCrossStructureSnapshot(db, semanticChecks);
  const compactionReport = compareConsistencySnapshots(beforeSnapshot, compactedSnapshot);
  assertCrossStructureCoreEqual(beforeSnapshot, compactedSnapshot);
  assertSemanticResultsReadable(compactedSnapshot);

  const reopened = await reopenBenchmarkDb(benchmark);
  const reopenedSnapshot = await captureCrossStructureSnapshot(reopened, semanticChecks);
  const reopenReport = assertCrossStructureSnapshotsEqual(compactedSnapshot, reopenedSnapshot);
  const reopenedDeleted = await reopened.semanticSearch('articles', 'benchmark semantic deleted tombstone', 5);
  assert(!reopenedDeleted.some((doc) => String(doc.getId()).startsWith('dead')));

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
  assert(result.relocatedHnswUnits > 0, 'durability scenario should exercise HNSW unit relocation');
  assert(result.reclaimedTailBlocks > 0, 'durability scenario should expose real tail shrink');
  assert.strictEqual(result.postReopenChecksPassed, true);

  await writeScenarioArtifacts(result);
  printScenarioResult(result);
  await reopened.close();
}

runIfMain(import.meta.url, main);
