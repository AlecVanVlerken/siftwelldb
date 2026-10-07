// @author: Alec Van Vlerken
// @date: 2026-05-07

import assert from 'assert';
import { performance } from 'node:perf_hooks';

import {
  deleteDocuments,
  benchmarkQueries,
  getStorageSample,
  insertDocuments,
  makeBenchmarkDb,
  makeHnswConfig,
  printScenarioResult,
  reopenBenchmarkDb,
  runIncrementalUntilStable,
  runIfMain,
  type ScenarioResult,
  type StepSample,
  writeScenarioArtifacts,
} from '../shared/benchmark-utils.mjs';

export async function main(): Promise<void> {
  await runHnswHeavyShrink();
  await runTargetedHnswRelocation();
}

async function runHnswHeavyShrink(): Promise<void> {
  const scenario = 'hnsw-heavy-shrink';
  const benchmark = await makeBenchmarkDb({
    hnsw: true,
    hnswConfig: makeHnswConfig({ dimension: 900, M: 4, maxStoredLevel: 4, efConstruction: 32, efSearch: 16 }),
  });
  const { db } = benchmark;

  await insertDocuments(db, 'filler', 'hole', 20, {
    payloadWords: 260,
    group: 'low-free-space',
    indexedFields: 1,
    skipSemanticIndex: true,
  });
  await db.commit();
  await insertDocuments(db, 'items', 'tail', 32, {
    payloadWords: 160,
    group: 'tail',
    semanticText: 'semantic tail vector',
  });
  await insertDocuments(db, 'items', 'dead', 4, {
    payloadWords: 120,
    group: 'deleted',
    semanticText: 'semantic deleted tombstone vector',
  });
  await db.commit();
  await deleteDocuments(db, 'items', 'dead', 4);
  await deleteDocuments(db, 'filler', 'hole', 20);
  await db.commit();

  const graphBefore = await db.inspectHnswGraphStructure('items');
  assert(
    graphBefore.some((node) => node.deleted),
    'fixture must create retained tombstoned HNSW units',
  );
  const semanticBefore = (await db.semanticSearch('items', 'semantic tail vector', 8)).map((doc) =>
    String(doc.getId()),
  );
  assert(semanticBefore.length > 0);
  assert(
    !(await db.semanticSearch('items', 'semantic deleted tombstone vector', 8)).some((doc) =>
      String(doc.getId()).startsWith('dead'),
    ),
  );

  const queryBefore = await benchmarkQueries(db, true);
  const result = await runIncrementalUntilStable(
    db,
    scenario,
    { maxAmplification: 1.05, softAmplification: 1.05, targetBatchDocuments: 6, targetBatchUnits: 6 },
    160,
  );
  await db.commit();
  const queryAfter = await benchmarkQueries(db, true);
  const semanticAfter = (await db.semanticSearch('items', 'semantic tail vector', 8)).map((doc) => String(doc.getId()));
  const graphAfter = await db.inspectHnswGraphStructure('items');
  assert(
    graphAfter.some((node) => node.deleted),
    'incremental compaction must preserve tombstones',
  );
  assert.deepStrictEqual(semanticAfter, semanticBefore);
  assert(
    !(await db.semanticSearch('items', 'semantic deleted tombstone vector', 8)).some((doc) =>
      String(doc.getId()).startsWith('dead'),
    ),
  );

  const reopened = await reopenBenchmarkDb(benchmark);
  const semanticReopened = (await reopened.semanticSearch('items', 'semantic tail vector', 8)).map((doc) =>
    String(doc.getId()),
  );
  const reopenedDeleted = await reopened.semanticSearch('items', 'semantic deleted tombstone vector', 8);
  const postReopenChecksPassed =
    arraysEqual(semanticReopened, semanticAfter) &&
    !reopenedDeleted.some((doc) => String(doc.getId()).startsWith('dead'));

  Object.assign(result, {
    sameSemanticResults: arraysEqual(semanticAfter, semanticBefore),
    semanticResultsReadable: semanticAfter.length > 0,
    postReopenChecksPassed,
    queryBefore,
    queryAfter,
  });

  assert(result.relocatedHnswUnits > 0);
  assert(result.reclaimedTailBlocks > 0);
  assert(result.shrunkBlocks > 0);
  assert.strictEqual(result.sameSemanticResults, true);
  assert.strictEqual(result.postReopenChecksPassed, true);

  await writeScenarioArtifacts(result);
  printScenarioResult(result);
  await reopened.close();
}

async function runTargetedHnswRelocation(): Promise<void> {
  const scenario = 'hnsw-tail-blocker';
  const benchmark = await makeBenchmarkDb({
    hnsw: true,
    hnswConfig: makeHnswConfig({ dimension: 900, M: 4, maxStoredLevel: 4, efConstruction: 32, efSearch: 16 }),
  });
  const { db } = benchmark;
  await insertDocuments(db, 'filler', 'hole', 18, {
    payloadWords: 260,
    group: 'low-free-space',
    indexedFields: 1,
    skipSemanticIndex: true,
  });
  await db.commit();
  await insertDocuments(db, 'items', 'tail', 28, {
    payloadWords: 140,
    group: 'tail',
    semanticText: 'semantic tail vector',
  });
  await insertDocuments(db, 'items', 'dead', 1, {
    payloadWords: 120,
    group: 'deleted',
    semanticText: 'semantic deleted tail blocker',
  });
  await db.commit();
  await deleteDocuments(db, 'items', 'dead', 1);
  await deleteDocuments(db, 'filler', 'hole', 18);
  await db.commit();

  const semanticBefore = (await db.semanticSearch('items', 'semantic tail vector', 5)).map((doc) =>
    String(doc.getId()),
  );
  assert(semanticBefore.length > 0);
  assert(
    !(await db.semanticSearch('items', 'semantic deleted tail blocker', 5)).some((doc) =>
      String(doc.getId()).startsWith('dead'),
    ),
  );
  const before = await getStorageSample(db);
  const boundary = Math.ceil(before.usedBlocks * 1.05);
  const targets = (await db.listHnswRelocationTargets('items')).sort(
    (a, b) => (b.blockNumber ?? 0) - (a.blockNumber ?? 0),
  );
  const target = targets.find(
    (candidate) =>
      candidate.kind === 'hnsw-vector' &&
      candidate.hnswUnitState === 'tombstoned-retained' &&
      (candidate.blockNumber ?? 0) >= boundary,
  );
  assert(target, 'fixture must create a tombstoned HNSW vector tail blocker above the target boundary');
  const maxBlockExclusive = Math.min(boundary, target.blockNumber ?? boundary);

  const start = performance.now();
  const stepStart = performance.now();
  assert(await db.relocateHnswUnit({ ...target, maxBlockExclusive }));
  await db.commit();
  const reclaimedTailBlocks = await db.trimFreeTail();
  const after = await getStorageSample(db);
  const semanticAfter = (await db.semanticSearch('items', 'semantic tail vector', 5)).map((doc) => String(doc.getId()));
  const graphAfter = await db.inspectHnswGraphStructure('items');
  assert(
    graphAfter.some((node) => node.deleted),
    'direct relocation must preserve tombstone state',
  );
  const step: StepSample = {
    scenario,
    step: 1,
    didWork: true,
    timeMs: performance.now() - stepStart,
    cumulativeShrunkBytes: before.fileBytes - after.fileBytes,
    relocatedDocuments: 0,
    relocatedBtreeNodes: 0,
    relocatedHnswUnits: 1,
    reclaimedTailBlocks,
    ...after,
  };
  const result: ScenarioResult = {
    scenario,
    status: after.amplification <= 1.05 ? 'converged' : 'plateau-no-safe-progress',
    before,
    after,
    shrunkBlocks: before.totalBlocks - after.totalBlocks,
    shrunkBytes: before.fileBytes - after.fileBytes,
    stepsTaken: 1,
    timeTakenMs: performance.now() - start,
    relocatedDocuments: 0,
    relocatedBtreeNodes: 0,
    relocatedHnswUnits: 1,
    reclaimedTailBlocks,
    history: [step],
  };

  const reopened = await reopenBenchmarkDb(benchmark);
  const semanticReopened = (await reopened.semanticSearch('items', 'semantic tail vector', 5)).map((doc) =>
    String(doc.getId()),
  );
  const reopenedDeleted = await reopened.semanticSearch('items', 'semantic deleted tail blocker', 5);
  Object.assign(result, {
    sameSemanticResults: arraysEqual(semanticAfter, semanticBefore),
    semanticResultsReadable: semanticAfter.length > 0,
    postReopenChecksPassed:
      arraysEqual(semanticReopened, semanticAfter) &&
      !reopenedDeleted.some((doc) => String(doc.getId()).startsWith('dead')),
  });

  assert.deepStrictEqual(semanticAfter, semanticBefore);
  assert(reclaimedTailBlocks > 0);
  assert(after.fileBytes < before.fileBytes);
  assert.strictEqual(result.postReopenChecksPassed, true);
  await writeScenarioArtifacts(result);
  printScenarioResult(result);
  await reopened.close();
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

runIfMain(import.meta.url, main);
