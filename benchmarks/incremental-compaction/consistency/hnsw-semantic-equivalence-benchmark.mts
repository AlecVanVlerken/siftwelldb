// @author: Alec Van Vlerken
// @date: 2026-05-08

import assert from 'assert';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';

import { MockFile } from '../../../tests/helpers/mockfile.mjs';
import { DbmsBack } from '../../../src/database/dbmsback.mjs';
import { vacuumCompactInto } from '../../../src/compaction/compaction.mjs';
import {
  buildSemanticEquivalenceDataset,
  captureSemanticEquivalenceSnapshot,
  makeSemanticEquivalenceDb,
  semanticSnapshotsEqual,
} from '../../../tests/helpers/semantic-equivalence.mjs';
import { getStorageSample, resultsDir, runIfMain, type StorageSample } from '../shared/benchmark-utils.mjs';

type SemanticEquivalenceBenchmarkResult = {
  scenario: string;
  before: StorageSample;
  afterIncremental: StorageSample;
  afterVacuum: StorageSample;
  exactAfterIncremental: boolean;
  exactAfterIncrementalReopen: boolean;
  exactAfterVacuum: boolean;
  exactAfterVacuumReopen: boolean;
  incrementalWork: {
    relocatedDocuments: number;
    relocatedBtreeNodes: number;
    relocatedHnswUnits: number;
    reclaimedTailBlocks: number;
  };
  realRelocationOccurred: boolean;
  fullVacuumHnswMode: 'deterministic-logical-rebuild';
  textResultsBefore: Record<string, string[]>;
  textResultsAfterIncremental: Record<string, string[]>;
  textResultsAfterVacuum: Record<string, string[]>;
  imageResultsBefore: Record<string, string[]>;
  imageResultsAfterIncremental: Record<string, string[]>;
  imageResultsAfterVacuum: Record<string, string[]>;
};

export async function main(): Promise<void> {
  const scenario = 'hnsw-semantic-equivalence';
  const incremental = await makeSemanticEquivalenceDb();
  await buildSemanticEquivalenceDataset(incremental.db, { fragmentation: true });

  const before = await getStorageSample(incremental.db);
  const beforeSnapshot = await captureSemanticEquivalenceSnapshot(incremental.db);

  const incrementalResult = await incremental.db.compactIfNeeded({
    maxAmplification: 1.05,
    softAmplification: 1.05,
    targetBatchDocuments: 8,
    targetBatchUnits: 8,
    maxStepsPerRun: 30,
  });
  await incremental.db.commit();

  assert(incrementalResult !== null);
  assert.strictEqual(incrementalResult.didWork, true);

  const incrementalSnapshot = await captureSemanticEquivalenceSnapshot(incremental.db);
  const exactAfterIncremental = semanticSnapshotsEqual(beforeSnapshot, incrementalSnapshot);

  await incremental.db.close();
  const incrementalReopened = await DbmsBack.open(incremental.data, incremental.log, incremental.hnswConfig);
  const incrementalReopenSnapshot = await captureSemanticEquivalenceSnapshot(incrementalReopened);
  const exactAfterIncrementalReopen = semanticSnapshotsEqual(beforeSnapshot, incrementalReopenSnapshot);
  const afterIncremental = await getStorageSample(incrementalReopened);
  await incrementalReopened.close();

  const vacuum = await makeSemanticEquivalenceDb();
  await buildSemanticEquivalenceDataset(vacuum.db, { fragmentation: true });
  const vacuumBeforeSnapshot = await captureSemanticEquivalenceSnapshot(vacuum.db);
  const tempData = new MockFile(4096);
  const tempLog = new MockFile(4096);
  const vacuumResult = await vacuumCompactInto({
    source: vacuum.db,
    tempDataFile: tempData,
    tempLogFile: tempLog,
    validate: true,
    rebuildHnsw: true,
  });
  const vacuumSnapshot = await captureSemanticEquivalenceSnapshot(vacuumResult.target);
  const exactAfterVacuum = semanticSnapshotsEqual(vacuumBeforeSnapshot, vacuumSnapshot);
  await vacuumResult.target.commit();
  await vacuumResult.target.close();
  const vacuumReopened = await DbmsBack.open(tempData, tempLog, vacuum.hnswConfig);
  const vacuumReopenSnapshot = await captureSemanticEquivalenceSnapshot(vacuumReopened);
  const exactAfterVacuumReopen = semanticSnapshotsEqual(vacuumBeforeSnapshot, vacuumReopenSnapshot);
  const afterVacuum = await getStorageSample(vacuumReopened);
  await vacuumReopened.close();
  await vacuum.db.close();

  const result: SemanticEquivalenceBenchmarkResult = {
    scenario,
    before,
    afterIncremental,
    afterVacuum,
    exactAfterIncremental,
    exactAfterIncrementalReopen,
    exactAfterVacuum,
    exactAfterVacuumReopen,
    incrementalWork: {
      relocatedDocuments: incrementalResult.relocatedDocuments ?? 0,
      relocatedBtreeNodes: incrementalResult.relocatedBtreeNodes ?? 0,
      relocatedHnswUnits: incrementalResult.relocatedHnswUnits ?? 0,
      reclaimedTailBlocks: incrementalResult.reclaimedTailBlocks ?? 0,
    },
    realRelocationOccurred:
      (incrementalResult.relocatedDocuments ?? 0) +
        (incrementalResult.relocatedBtreeNodes ?? 0) +
        (incrementalResult.relocatedHnswUnits ?? 0) >
      0,
    fullVacuumHnswMode: 'deterministic-logical-rebuild',
    textResultsBefore: beforeSnapshot.textResultIds,
    textResultsAfterIncremental: incrementalSnapshot.textResultIds,
    textResultsAfterVacuum: vacuumSnapshot.textResultIds,
    imageResultsBefore: beforeSnapshot.imageResultIds,
    imageResultsAfterIncremental: incrementalSnapshot.imageResultIds,
    imageResultsAfterVacuum: vacuumSnapshot.imageResultIds,
  };

  await fs.mkdir(resultsDir, { recursive: true });
  await fs.writeFile(join(resultsDir, `${scenario}.json`), JSON.stringify(result, null, 2));
  printResult(result);

  assert.strictEqual(exactAfterIncremental, true);
  assert.strictEqual(exactAfterIncrementalReopen, true);
  assert.strictEqual(exactAfterVacuum, true);
  assert.strictEqual(exactAfterVacuumReopen, true);
  assert.strictEqual(result.realRelocationOccurred, true);
}

function printResult(result: SemanticEquivalenceBenchmarkResult): void {
  console.log('--- HNSW SEMANTIC EQUIVALENCE ---');
  console.log(
    `Incremental exact: compaction=${String(result.exactAfterIncremental)} reopen=${String(
      result.exactAfterIncrementalReopen,
    )}`,
  );
  console.log(
    `Full vacuum exact: compaction=${String(result.exactAfterVacuum)} reopen=${String(result.exactAfterVacuumReopen)}`,
  );
  console.log(
    `Blocks: before=${result.before.totalBlocks.toString()} incremental=${result.afterIncremental.totalBlocks.toString()} ` +
      `vacuum=${result.afterVacuum.totalBlocks.toString()}`,
  );
  console.log(
    `Incremental work: records=${result.incrementalWork.relocatedDocuments.toString()} ` +
      `btree=${result.incrementalWork.relocatedBtreeNodes.toString()} ` +
      `hnsw=${result.incrementalWork.relocatedHnswUnits.toString()} ` +
      `tail=${result.incrementalWork.reclaimedTailBlocks.toString()}`,
  );
  console.log(`Real relocation occurred: ${String(result.realRelocationOccurred)}`);
  console.log(`Full vacuum HNSW mode: ${result.fullVacuumHnswMode}`);
  console.log('Text result IDs before:');
  console.log(JSON.stringify(result.textResultsBefore, null, 2));
  console.log('Text result IDs after incremental:');
  console.log(JSON.stringify(result.textResultsAfterIncremental, null, 2));
  console.log('Text result IDs after full vacuum:');
  console.log(JSON.stringify(result.textResultsAfterVacuum, null, 2));
}

runIfMain(import.meta.url, main);
