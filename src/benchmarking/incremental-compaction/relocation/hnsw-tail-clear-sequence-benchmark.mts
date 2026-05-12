// @author: Alec Van Vlerken
// @date: 2026-05-07

import assert from 'assert';
import { performance } from 'node:perf_hooks';

import {
  DEFAULT_K,
  printScenarioResult,
  runIfMain,
  type ScenarioResult,
  type StepSample,
  writeScenarioArtifacts,
} from '../shared/benchmark-utils.mjs';
import { relocateHnswTarget } from './hnsw-dominant-tail-blocker-benchmark.mjs';
import {
  allocateFillerBlocks,
  buildHnswIndex,
  freeFillerBlocks,
  makeTargetFile,
  sampleFile,
  vectorFor,
} from '../shared/targeted-storage-utils.mjs';

export async function main(): Promise<void> {
  const scenario = 'hnsw-tail-clear-sequence';
  const file = await makeTargetFile(1024);
  const lowFillers = await allocateFillerBlocks(file, 48);
  const index = await buildHnswIndex(file, 48, {
    M: 20,
    maxStoredLevel: 4,
    efConstruction: 64,
    efSearch: 16,
  });
  await file.commit();
  await freeFillerBlocks(file, lowFillers);
  await file.commit();

  const semanticBefore = await index.search(vectorFor(20), 8);
  const before = await sampleFile(file);
  const history: StepSample[] = [];
  let relocatedHnswUnits = 0;
  let reclaimedTailBlocks = 0;
  const start = performance.now();

  for (let stepNumber = 1; stepNumber <= 5; stepNumber++) {
    const previous = await sampleFile(file);
    const target = (await index.listRelocationTargets())
      .filter((candidate) => candidate.kind === 'hnsw-graph')
      .sort((a, b) => (b.blockNumber ?? 0) - (a.blockNumber ?? 0))[0];
    assert(target?.nodeId !== undefined && target.blockNumber !== undefined);
    const boundary = Math.min(Math.ceil(previous.usedBlocks * DEFAULT_K), target.blockNumber);
    const stepStart = performance.now();
    await relocateHnswTarget(index, target, boundary);
    relocatedHnswUnits++;
    await file.commit();
    const reclaimed = (await file.trimFreeTail()).removedBlocks;
    reclaimedTailBlocks += reclaimed;
    const current = await sampleFile(file);

    history.push({
      scenario,
      step: stepNumber,
      didWork: true,
      timeMs: performance.now() - stepStart,
      shrunkBlocksThisStep: previous.totalBlocks - current.totalBlocks,
      cumulativeShrunkBytes: before.fileBytes - current.fileBytes,
      stepRelocatedDocuments: 0,
      stepRelocatedBtreeNodes: 0,
      stepRelocatedHnswUnits: 1,
      stepReclaimedTailBlocks: reclaimed,
      relocatedDocuments: 0,
      relocatedBtreeNodes: 0,
      relocatedHnswUnits,
      reclaimedTailBlocks,
      ...current,
    });

    if (current.amplification <= DEFAULT_K) break;
  }

  const semanticAfter = await index.search(vectorFor(20), 8);
  const after = await sampleFile(file);
  assert(semanticAfter.some((docId) => semanticBefore.includes(docId)));
  assert(relocatedHnswUnits > 1);
  assert(after.fileBytes < before.fileBytes);

  const result: ScenarioResult = {
    scenario,
    status: after.amplification <= DEFAULT_K ? 'converged' : 'plateau-no-safe-progress',
    before,
    after,
    shrunkBlocks: before.totalBlocks - after.totalBlocks,
    shrunkBytes: before.fileBytes - after.fileBytes,
    stepsTaken: history.length,
    timeTakenMs: performance.now() - start,
    relocatedDocuments: 0,
    relocatedBtreeNodes: 0,
    relocatedHnswUnits,
    reclaimedTailBlocks,
    history,
  };

  await writeScenarioArtifacts(result);
  printScenarioResult(result);
}

runIfMain(import.meta.url, main);
