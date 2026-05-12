// @author: Alec Van Vlerken
// @date: 2026-05-08

import assert from 'assert';

import {
  captureCrossStructureSnapshot,
  assertCrossStructureCoreEqual,
} from '../shared/consistency-utils.mjs';
import {
  DEFAULT_K,
  deleteDocuments,
  insertDocuments,
  makeBenchmarkDb,
  reopenBenchmarkDb,
  runIfMain,
  runIncrementalUntilStable,
  writeScenarioArtifacts,
  type ScenarioResult,
  type StepSample,
} from '../shared/benchmark-utils.mjs';

const semanticChecks = [{ collection: 'items', query: 'stable live semantic', k: 5 }];

export async function main(): Promise<void> {
  const benchmark = await makeBenchmarkDb({ hnsw: true });
  const policy = {
    maxAmplification: DEFAULT_K,
    softAmplification: DEFAULT_K,
    targetBatchDocuments: 3,
    targetBatchUnits: 3,
    maxStepsPerRun: 1,
  };
  const history: StepSample[] = [];

  await insertDocuments(benchmark.db, 'items', 'base', 16, {
    payloadWords: 120,
    group: 'base',
    indexedFields: 2,
    semanticText: 'stable live semantic',
  });
  await benchmark.db.commit();

  const before = await benchmark.db.getCompactionStorageStats();
  let relocatedDocuments = 0;
  let relocatedBtreeNodes = 0;
  let relocatedHnswUnits = 0;
  let reclaimedTailBlocks = 0;

  for (let cycle = 1; cycle <= 5; cycle++) {
    await insertDocuments(benchmark.db, 'items', `dead${cycle}-`, 10, {
      payloadWords: 90,
      group: `dead-${cycle.toString()}`,
      indexedFields: 2,
      semanticText: 'stable dead semantic',
    });
    await benchmark.db.commit();
    await insertDocuments(benchmark.db, 'items', `live${cycle}-`, 8, {
      payloadWords: 90,
      group: `live-${cycle.toString()}`,
      indexedFields: 2,
      semanticText: 'stable live semantic',
    });
    await benchmark.db.commit();
    await deleteDocuments(benchmark.db, 'items', `dead${cycle}-`, 10);
    await benchmark.db.commit();

    const expected = await captureCrossStructureSnapshot(benchmark.db, semanticChecks);
    const result = await runIncrementalUntilStable(benchmark.db, `maintenance-stability-cycle-${cycle.toString()}`, policy, 60);
    const afterCompaction = await captureCrossStructureSnapshot(benchmark.db, semanticChecks);
    assertCrossStructureCoreEqual(expected, afterCompaction);

    await benchmark.db.commit();
    const reopened = await reopenBenchmarkDb(benchmark);
    const afterReopen = await captureCrossStructureSnapshot(reopened, semanticChecks);
    assertCrossStructureCoreEqual(expected, afterReopen);
    benchmark.db = reopened;

    const stepOffset = history.length;
    history.push(...result.history.map((step) => ({ ...step, scenario: 'maintenance-stability', step: step.step + stepOffset })));
    relocatedDocuments += result.relocatedDocuments;
    relocatedBtreeNodes += result.relocatedBtreeNodes;
    relocatedHnswUnits += result.relocatedHnswUnits;
    reclaimedTailBlocks += result.reclaimedTailBlocks;
  }

  const after = await benchmark.db.getCompactionStorageStats();
  const scenario: ScenarioResult = {
    scenario: 'maintenance-stability',
    status: after.totalBlocks / Math.max(1, after.usedBlocks) <= DEFAULT_K ? 'converged' : 'plateau-no-safe-progress',
    before: {
      totalBlocks: before.totalBlocks,
      usedBlocks: before.usedBlocks,
      freeBlocks: before.freeBlocks,
      amplification: before.totalBlocks / Math.max(1, before.usedBlocks),
      fileBytes: before.fileSizeBytes,
    },
    after: {
      totalBlocks: after.totalBlocks,
      usedBlocks: after.usedBlocks,
      freeBlocks: after.freeBlocks,
      amplification: after.totalBlocks / Math.max(1, after.usedBlocks),
      fileBytes: after.fileSizeBytes,
    },
    shrunkBlocks: before.totalBlocks - after.totalBlocks,
    shrunkBytes: before.fileSizeBytes - after.fileSizeBytes,
    stepsTaken: history.length,
    timeTakenMs: history.reduce((sum, step) => sum + step.timeMs, 0),
    relocatedDocuments,
    relocatedBtreeNodes,
    relocatedHnswUnits,
    reclaimedTailBlocks,
    sameIds: true,
    sameDocumentContents: true,
    sameIndexedResults: true,
    sameCursorResults: true,
    sameSemanticResults: true,
    semanticResultsReadable: true,
    postReopenChecksPassed: true,
    history,
  };

  await writeScenarioArtifacts(scenario);
  assert(history.length > 0);
  await benchmark.db.close();
}

runIfMain(import.meta.url, main);
