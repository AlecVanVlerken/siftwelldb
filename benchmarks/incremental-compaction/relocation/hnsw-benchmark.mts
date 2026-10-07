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
  runAndWriteScenario,
  runIfMain,
  type ScenarioResult,
  type StepSample,
  writeScenarioArtifacts,
} from '../shared/benchmark-utils.mjs';

export async function main(): Promise<void> {
  await runAndWriteScenario(
    'hnsw-heavy-shrink',
    async (db) => {
      await insertDocuments(db, 'items', 'free', 24, {
        payloadWords: 180,
        group: 'free',
        semanticText: 'semantic free vector',
      });
      await db.commit();
      await insertDocuments(db, 'items', 'tail', 32, {
        payloadWords: 180,
        group: 'tail',
        semanticText: 'semantic tail vector',
      });
      await db.commit();
      await deleteDocuments(db, 'items', 'free', 24);
      await db.commit();
    },
    {
      hnsw: true,
      policy: {
        maxAmplification: DEFAULT_K,
        softAmplification: DEFAULT_K,
        targetBatchDocuments: 4,
        targetBatchUnits: 4,
      },
      maxSteps: 120,
      benchmarkQueries: true,
    },
  );

  await runTargetedHnswRelocation();
}

async function runTargetedHnswRelocation(): Promise<void> {
  const scenario = 'hnsw-tail-blocker';
  const { db } = await makeBenchmarkDb({ hnsw: true });
  await insertDocuments(db, 'items', 'free', 18, {
    payloadWords: 140,
    group: 'free',
    semanticText: 'semantic free vector',
  });
  await db.commit();
  await insertDocuments(db, 'items', 'tail', 28, {
    payloadWords: 140,
    group: 'tail',
    semanticText: 'semantic tail vector',
  });
  await db.commit();
  await deleteDocuments(db, 'items', 'free', 18);
  await db.commit();

  const semanticBefore = (await db.semanticSearch('items', 'semantic tail vector', 5)).map((doc) =>
    String(doc.getId()),
  );
  const before = await getStorageSample(db);
  const boundary = Math.ceil(before.usedBlocks * DEFAULT_K);
  const targets = (await db.listHnswRelocationTargets('items')).sort(
    (a, b) => (b.blockNumber ?? 0) - (a.blockNumber ?? 0),
  );
  const target = targets.find((candidate) => (candidate.blockNumber ?? 0) >= boundary) ?? targets[0];
  assert(target);
  const maxBlockExclusive = Math.min(boundary, target.blockNumber ?? boundary);

  const start = performance.now();
  const stepStart = performance.now();
  assert(await db.relocateHnswUnit({ ...target, maxBlockExclusive }));
  await db.commit();
  const reclaimedTailBlocks = await db.trimFreeTail();
  const after = await getStorageSample(db);
  const semanticAfter = (await db.semanticSearch('items', 'semantic tail vector', 5)).map((doc) => String(doc.getId()));
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
    status: after.amplification <= DEFAULT_K ? 'converged' : 'plateau-no-safe-progress',
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

  assert(semanticAfter.some((id) => semanticBefore.includes(id)));
  await writeScenarioArtifacts(result);
  printScenarioResult(result);
  await db.close();
}

runIfMain(import.meta.url, main);
