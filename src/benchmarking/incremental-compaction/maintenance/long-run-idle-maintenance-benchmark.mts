// @author: Alec Van Vlerken
// @date: 2026-05-08

import assert from 'assert';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';

import {
  DEFAULT_K,
  deleteDocuments,
  editDocuments,
  getStorageSample,
  insertDocuments,
  makeBenchmarkDb,
  makeHnswConfig,
  resultsDir,
  runIfMain,
  runIncrementalUntilStable,
  writeScenarioArtifacts,
  type BenchmarkStatus,
  type ScenarioResult,
  type StepSample,
} from '../shared/benchmark-utils.mjs';

type PhaseSample = {
  phase: number;
  status: BenchmarkStatus;
  beforeBlocks: number;
  afterBlocks: number;
  beforeAmplification: number;
  afterAmplification: number;
  stepsTaken: number;
  shrunkBlocks: number;
  shrunkBytes: number;
  relocatedDocuments: number;
  relocatedBtreeNodes: number;
  relocatedHnswUnits: number;
  reclaimedTailBlocks: number;
  timeTakenMs: number;
};

export async function main(): Promise<void> {
  const benchmark = await makeBenchmarkDb({
    hnsw: true,
    hnswConfig: makeHnswConfig({ dimension: 900, M: 4, maxStoredLevel: 4, efConstruction: 32, efSearch: 16 }),
  });
  const policy = {
    maxAmplification: DEFAULT_K,
    softAmplification: DEFAULT_K,
    targetBatchDocuments: 3,
    targetBatchUnits: 3,
    maxStepsPerRun: 1,
  };

  const history: StepSample[] = [];
  const phases: PhaseSample[] = [];
  const beforeAll = await getStorageSample(benchmark.db);
  let firstMaintenanceBefore: typeof beforeAll | null = null;
  let relocatedDocuments = 0;
  let relocatedBtreeNodes = 0;
  let relocatedHnswUnits = 0;
  let reclaimedTailBlocks = 0;

  for (let phase = 1; phase <= 3; phase++) {
    await insertDocuments(benchmark.db, 'filler', `hole${phase}-`, 14, {
      payloadWords: 220,
      group: `phase-${phase.toString()}-free`,
      indexedFields: 2,
      skipSemanticIndex: true,
    });
    await benchmark.db.commit();
    await insertDocuments(benchmark.db, 'items', `tail${phase}-`, 18, {
      payloadWords: 150,
      group: `phase-${phase.toString()}-tail`,
      indexedFields: 3,
      semanticText: `phase ${phase.toString()} tail semantic`,
    });
    await insertDocuments(benchmark.db, 'items', `dead${phase}-`, 2, {
      payloadWords: 120,
      group: `phase-${phase.toString()}-deleted`,
      indexedFields: 2,
      semanticText: `phase ${phase.toString()} deleted tombstone semantic`,
    });
    await benchmark.db.commit();
    await editDocuments(benchmark.db, 'items', `tail${phase}-`, 4);
    await deleteDocuments(benchmark.db, 'items', `dead${phase}-`, 2);
    await deleteDocuments(benchmark.db, 'filler', `hole${phase}-`, 14);
    await benchmark.db.commit();

    const result = await runIncrementalUntilStable(
      benchmark.db,
      `long-run-idle-maintenance-phase-${phase.toString()}`,
      policy,
      70,
    );
    firstMaintenanceBefore ??= result.before;
    const stepOffset = history.length;
    history.push(
      ...result.history.map((step) => ({
        ...step,
        scenario: 'long-run-idle-maintenance',
        step: step.step + stepOffset,
      })),
    );
    phases.push({
      phase,
      status: result.status,
      beforeBlocks: result.before.totalBlocks,
      afterBlocks: result.after.totalBlocks,
      beforeAmplification: result.before.amplification,
      afterAmplification: result.after.amplification,
      stepsTaken: result.stepsTaken,
      shrunkBlocks: result.shrunkBlocks,
      shrunkBytes: result.shrunkBytes,
      relocatedDocuments: result.relocatedDocuments,
      relocatedBtreeNodes: result.relocatedBtreeNodes,
      relocatedHnswUnits: result.relocatedHnswUnits,
      reclaimedTailBlocks: result.reclaimedTailBlocks,
      timeTakenMs: result.timeTakenMs,
    });

    relocatedDocuments += result.relocatedDocuments;
    relocatedBtreeNodes += result.relocatedBtreeNodes;
    relocatedHnswUnits += result.relocatedHnswUnits;
    reclaimedTailBlocks += result.reclaimedTailBlocks;

    assert(
      result.status === 'converged' ||
        result.status === 'plateau-no-safe-progress' ||
        (result.status === 'no-op' && result.before.amplification <= DEFAULT_K) ||
        (result.status === 'budget-exhausted' && phaseDidUsefulWork(result)),
      `phase ${phase.toString()} ended with ${result.status} without useful maintenance progress`,
    );
  }

  const afterAll = await getStorageSample(benchmark.db);
  const exhaustedBudget = phases.some((phase) => phase.status === 'budget-exhausted');
  const totalShrunkBlocks = phases.reduce((sum, phase) => sum + phase.shrunkBlocks, 0);
  const totalShrunkBytes = phases.reduce((sum, phase) => sum + phase.shrunkBytes, 0);
  const combined: ScenarioResult = {
    scenario: 'long-run-idle-maintenance',
    status: afterAll.amplification <= DEFAULT_K ? 'converged' : exhaustedBudget ? 'budget-exhausted' : 'plateau-no-safe-progress',
    before: firstMaintenanceBefore ?? beforeAll,
    after: afterAll,
    shrunkBlocks: totalShrunkBlocks,
    shrunkBytes: totalShrunkBytes,
    stepsTaken: history.length,
    timeTakenMs: phases.reduce((sum, phase) => sum + phase.timeTakenMs, 0),
    relocatedDocuments,
    relocatedBtreeNodes,
    relocatedHnswUnits,
    reclaimedTailBlocks,
    history,
  };

  await writeScenarioArtifacts(combined);
  await writeTimeline(phases);
  assert(history.length > 3);
  assert(relocatedDocuments + relocatedBtreeNodes + relocatedHnswUnits + reclaimedTailBlocks > 0);
  await benchmark.db.close();
}

async function writeTimeline(phases: PhaseSample[]): Promise<void> {
  await fs.mkdir(resultsDir, { recursive: true });
  const header = [
    'scenario',
    'phase',
    'status',
    'beforeBlocks',
    'afterBlocks',
    'beforeAmplification',
    'afterAmplification',
    'stepsTaken',
    'shrunkBlocks',
    'relocatedDocuments',
    'relocatedBtreeNodes',
    'relocatedHnswUnits',
    'reclaimedTailBlocks',
    'timeTakenMs',
  ];
  const rows = phases.map((phase) =>
    [
      'long-run-idle-maintenance',
      phase.phase,
      phase.status,
      phase.beforeBlocks,
      phase.afterBlocks,
      phase.beforeAmplification.toFixed(4),
      phase.afterAmplification.toFixed(4),
      phase.stepsTaken,
      phase.shrunkBlocks,
      phase.relocatedDocuments,
      phase.relocatedBtreeNodes,
      phase.relocatedHnswUnits,
      phase.reclaimedTailBlocks,
      phase.timeTakenMs.toFixed(3),
    ].join(','),
  );
  await fs.writeFile(
    join(resultsDir, 'long-run-idle-maintenance-timeline.csv'),
    [header.join(','), ...rows].join('\n'),
  );
}

function phaseDidUsefulWork(result: ScenarioResult): boolean {
  return (
    result.history.some((step) => step.didWork) &&
    result.relocatedDocuments + result.relocatedBtreeNodes + result.relocatedHnswUnits + result.reclaimedTailBlocks > 0
  );
}

runIfMain(import.meta.url, main);
