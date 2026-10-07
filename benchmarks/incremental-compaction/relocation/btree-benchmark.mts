// @author: Alec Van Vlerken
// @date: 2026-05-07

import assert from 'assert';
import { performance } from 'node:perf_hooks';

import {
  DEFAULT_K,
  deleteDocuments,
  getStorageSample,
  insertDocuments,
  makeBenchmarkDb,
  printScenarioResult,
  queryIds,
  runAndWriteScenario,
  runIfMain,
  type ScenarioResult,
  type StepSample,
  writeScenarioArtifacts,
} from '../shared/benchmark-utils.mjs';

export async function main(): Promise<void> {
  await runAndWriteScenario(
    'multi-index-shrink',
    async (db) => {
      await insertDocuments(db, 'items', 'free', 80, { payloadWords: 60, group: 'free', indexedFields: 6 });
      await db.commit();
      await insertDocuments(db, 'items', 'tail', 120, { payloadWords: 60, group: 'tail', indexedFields: 6 });
      await db.commit();
      await deleteDocuments(db, 'items', 'free', 80);
      await db.commit();
    },
    {
      policy: {
        maxAmplification: DEFAULT_K,
        softAmplification: DEFAULT_K,
        targetBatchDocuments: 8,
        targetBatchUnits: 8,
      },
      maxSteps: 160,
    },
  );

  await runTargetedBtreeRelocation();
}

async function runTargetedBtreeRelocation(): Promise<void> {
  const scenario = 'btree-tail-blocker';
  const { db } = await makeBenchmarkDb();
  await insertDocuments(db, 'items', 'free', 90, { payloadWords: 40, group: 'free', indexedFields: 8 });
  await db.commit();
  await insertDocuments(db, 'items', 'tail', 140, { payloadWords: 40, group: 'tail', indexedFields: 8 });
  await db.commit();
  await deleteDocuments(db, 'items', 'free', 90);
  await db.commit();

  const tailIdsBefore = await queryIds(db, 'items', 'group', 'tail');
  const before = await getStorageSample(db);
  const boundary = Math.ceil(before.usedBlocks * DEFAULT_K);
  const targets = await db.listBtreeRelocationTargets(200);
  const sortedTargets = targets.sort((a, b) => (b.blockNumber ?? 0) - (a.blockNumber ?? 0));
  const target =
    sortedTargets.find(
      (candidate) =>
        candidate.collection !== undefined &&
        candidate.field !== undefined &&
        candidate.blockNumber !== undefined &&
        candidate.blockNumber >= boundary,
    ) ??
    sortedTargets.find(
      (candidate) =>
        candidate.collection !== undefined && candidate.field !== undefined && candidate.blockNumber !== undefined,
    );
  assert(target?.collection !== undefined && target.field !== undefined && target.blockNumber !== undefined);
  const maxBlockExclusive = Math.min(boundary, target.blockNumber);

  const start = performance.now();
  const stepStart = performance.now();
  await db.relocateBtreeNode(target.collection, target.field, target.blockNumber, { maxBlockExclusive });
  await db.commit();
  const reclaimedTailBlocks = await db.trimFreeTail();
  const after = await getStorageSample(db);
  const step: StepSample = {
    scenario,
    step: 1,
    didWork: true,
    timeMs: performance.now() - stepStart,
    cumulativeShrunkBytes: before.fileBytes - after.fileBytes,
    relocatedDocuments: 0,
    relocatedBtreeNodes: 1,
    relocatedHnswUnits: 0,
    reclaimedTailBlocks,
    ...after,
  };
  const result: ScenarioResult = {
    scenario,
    status: after.amplification <= DEFAULT_K ? 'converged' : 'plateau-no-safe-progress',
    before,
    after,
    shrunkBlocks: before.totalBlocks - after.totalBlocks,
    shrunkBytes: before.fileBytes - after.fileBytes,
    stepsTaken: 1,
    timeTakenMs: performance.now() - start,
    relocatedDocuments: 0,
    relocatedBtreeNodes: 1,
    relocatedHnswUnits: 0,
    reclaimedTailBlocks,
    history: [step],
  };

  assert.deepStrictEqual(await queryIds(db, 'items', 'group', 'tail'), tailIdsBefore);
  await writeScenarioArtifacts(result);
  printScenarioResult(result);
  await db.close();
}

runIfMain(import.meta.url, main);
