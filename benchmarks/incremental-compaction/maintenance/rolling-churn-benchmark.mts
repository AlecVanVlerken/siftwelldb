// @author: Alec Van Vlerken
// @date: 2026-05-08

import assert from 'assert';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';

import type { DbmsBack } from '../../../src/database/dbmsback.mjs';
import {
  DEFAULT_K,
  deleteDocuments,
  editDocuments,
  getStorageSample,
  insertDocuments,
  makeBenchmarkDb,
  queryIds,
  reopenBenchmarkDb,
  resultsDir,
  runIfMain,
  runIncrementalUntilStable,
  writeScenarioArtifacts,
  type ScenarioResult,
  type StepSample,
} from '../shared/benchmark-utils.mjs';

type CycleSample = {
  cycle: number;
  afterChurnBlocks: number;
  afterMaintenanceBlocks: number;
  afterChurnAmplification: number;
  afterMaintenanceAmplification: number;
  compactSteps: number;
};

export async function main(): Promise<void> {
  const benchmark = await makeBenchmarkDb({ hnsw: true });
  const policy = {
    maxAmplification: DEFAULT_K,
    softAmplification: DEFAULT_K,
    targetBatchDocuments: 4,
    targetBatchUnits: 4,
    maxStepsPerRun: 1,
  };

  const before = await getStorageSample(benchmark.db);
  const history: StepSample[] = [];
  const cycles: CycleSample[] = [];
  let relocatedDocuments = 0;
  let relocatedBtreeNodes = 0;
  let relocatedHnswUnits = 0;
  let reclaimedTailBlocks = 0;

  for (let cycle = 1; cycle <= 4; cycle++) {
    await insertDocuments(benchmark.db, 'items', `old${cycle}-`, 16, {
      payloadWords: 110,
      group: `old-${cycle.toString()}`,
      indexedFields: 2,
      semanticText: `old churn semantic ${cycle.toString()}`,
    });
    await benchmark.db.commit();
    await insertDocuments(benchmark.db, 'items', `live${cycle}-`, 22, {
      payloadWords: 130,
      group: `live-${cycle.toString()}`,
      indexedFields: 2,
      semanticText: `live churn semantic ${cycle.toString()}`,
    });
    await benchmark.db.commit();
    await editDocuments(benchmark.db, 'items', `live${cycle}-`, 8);
    await deleteDocuments(benchmark.db, 'items', `old${cycle}-`, 16);
    await benchmark.db.commit();

    const afterChurn = await getStorageSample(benchmark.db);
    const result = await runIncrementalUntilStable(benchmark.db, `rolling-churn-cycle-${cycle.toString()}`, policy, 80);
    const stepOffset = history.length;
    history.push(
      ...result.history.map((step) => ({ ...step, scenario: 'rolling-churn', step: step.step + stepOffset })),
    );
    const afterMaintenance = await getStorageSample(benchmark.db);

    cycles.push({
      cycle,
      afterChurnBlocks: afterChurn.totalBlocks,
      afterMaintenanceBlocks: afterMaintenance.totalBlocks,
      afterChurnAmplification: afterChurn.amplification,
      afterMaintenanceAmplification: afterMaintenance.amplification,
      compactSteps: result.stepsTaken,
    });

    relocatedDocuments += result.relocatedDocuments;
    relocatedBtreeNodes += result.relocatedBtreeNodes;
    relocatedHnswUnits += result.relocatedHnswUnits;
    reclaimedTailBlocks += result.reclaimedTailBlocks;

    await assertRollingQueries(benchmark.db, cycle);
    await benchmark.db.commit();
    const reopened = await reopenBenchmarkDb(benchmark);
    await assertRollingQueries(reopened, cycle);
    benchmark.db = reopened;
  }

  const after = await getStorageSample(benchmark.db);
  const combined: ScenarioResult = {
    scenario: 'rolling-churn',
    status: after.amplification <= DEFAULT_K ? 'converged' : 'plateau-no-safe-progress',
    before,
    after,
    shrunkBlocks: before.totalBlocks - after.totalBlocks,
    shrunkBytes: before.fileBytes - after.fileBytes,
    stepsTaken: history.length,
    timeTakenMs: history.reduce((sum, step) => sum + step.timeMs, 0),
    relocatedDocuments,
    relocatedBtreeNodes,
    relocatedHnswUnits,
    reclaimedTailBlocks,
    history,
  };

  await writeScenarioArtifacts(combined);
  await writeTimeline(cycles);
  assert(history.length >= 4);
  await benchmark.db.close();
}

async function assertRollingQueries(db: DbmsBack, cycle: number): Promise<void> {
  const latestGroup = `live-${cycle.toString()}`;
  const ids = await queryIds(db, 'items', 'group', latestGroup);
  assert(ids.length > 0);
  const semantic = await db.semanticSearch('items', `live churn semantic ${cycle.toString()}`, 3);
  assert(semantic.length > 0);
}

async function writeTimeline(cycles: CycleSample[]): Promise<void> {
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
  const rows = cycles.map((cycle) =>
    [
      'rolling-churn',
      cycle.cycle,
      cycle.afterChurnBlocks,
      cycle.afterMaintenanceBlocks,
      cycle.afterChurnAmplification.toFixed(4),
      cycle.afterMaintenanceAmplification.toFixed(4),
      cycle.compactSteps,
      Math.max(0, cycle.afterChurnBlocks - cycle.afterMaintenanceBlocks),
      '',
    ].join(','),
  );
  await fs.writeFile(join(resultsDir, 'rolling-churn-timeline.csv'), [header.join(','), ...rows].join('\n'));
}

runIfMain(import.meta.url, main);
