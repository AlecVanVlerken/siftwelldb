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
  resultsDir,
  runIfMain,
  runIncrementalUntilStable,
  writeScenarioArtifacts,
  type ScenarioResult,
  type StepSample,
} from '../shared/benchmark-utils.mjs';

type PhaseSample = {
  phase: number;
  beforeBlocks: number;
  afterBlocks: number;
  beforeAmplification: number;
  afterAmplification: number;
  stepsTaken: number;
  shrunkBlocks: number;
  timeTakenMs: number;
};

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
  const phases: PhaseSample[] = [];
  const beforeAll = await getStorageSample(benchmark.db);
  let relocatedDocuments = 0;
  let relocatedBtreeNodes = 0;
  let relocatedHnswUnits = 0;
  let reclaimedTailBlocks = 0;

  for (let phase = 1; phase <= 3; phase++) {
    await insertDocuments(benchmark.db, 'items', `free${phase}-`, 20, {
      payloadWords: 180,
      group: `phase-${phase.toString()}-free`,
      indexedFields: 3,
      semanticText: `phase ${phase.toString()} free semantic`,
    });
    await benchmark.db.commit();
    await insertDocuments(benchmark.db, 'items', `tail${phase}-`, 24, {
      payloadWords: 180,
      group: `phase-${phase.toString()}-tail`,
      indexedFields: 3,
      semanticText: `phase ${phase.toString()} tail semantic`,
    });
    await benchmark.db.commit();
    await editDocuments(benchmark.db, 'items', `tail${phase}-`, 6);
    await deleteDocuments(benchmark.db, 'items', `free${phase}-`, 20);
    await benchmark.db.commit();

    const result = await runIncrementalUntilStable(
      benchmark.db,
      `long-run-idle-maintenance-phase-${phase.toString()}`,
      policy,
      70,
    );
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
      beforeBlocks: result.before.totalBlocks,
      afterBlocks: result.after.totalBlocks,
      beforeAmplification: result.before.amplification,
      afterAmplification: result.after.amplification,
      stepsTaken: result.stepsTaken,
      shrunkBlocks: result.shrunkBlocks,
      timeTakenMs: result.timeTakenMs,
    });

    relocatedDocuments += result.relocatedDocuments;
    relocatedBtreeNodes += result.relocatedBtreeNodes;
    relocatedHnswUnits += result.relocatedHnswUnits;
    reclaimedTailBlocks += result.reclaimedTailBlocks;

    assert(result.status === 'converged' || result.status === 'plateau-no-safe-progress');
  }

  const afterAll = await getStorageSample(benchmark.db);
  const combined: ScenarioResult = {
    scenario: 'long-run-idle-maintenance',
    status: afterAll.amplification <= DEFAULT_K ? 'converged' : 'plateau-no-safe-progress',
    before: beforeAll,
    after: afterAll,
    shrunkBlocks: beforeAll.totalBlocks - afterAll.totalBlocks,
    shrunkBytes: beforeAll.fileBytes - afterAll.fileBytes,
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
  await benchmark.db.close();
}

async function writeTimeline(phases: PhaseSample[]): Promise<void> {
  await fs.mkdir(resultsDir, { recursive: true });
  const header = [
    'scenario',
    'phase',
    'beforeBlocks',
    'afterBlocks',
    'beforeAmplification',
    'afterAmplification',
    'stepsTaken',
    'shrunkBlocks',
    'timeTakenMs',
  ];
  const rows = phases.map((phase) =>
    [
      'long-run-idle-maintenance',
      phase.phase,
      phase.beforeBlocks,
      phase.afterBlocks,
      phase.beforeAmplification.toFixed(4),
      phase.afterAmplification.toFixed(4),
      phase.stepsTaken,
      phase.shrunkBlocks,
      phase.timeTakenMs.toFixed(3),
    ].join(','),
  );
  await fs.writeFile(
    join(resultsDir, 'long-run-idle-maintenance-timeline.csv'),
    [header.join(','), ...rows].join('\n'),
  );
}

runIfMain(import.meta.url, main);
