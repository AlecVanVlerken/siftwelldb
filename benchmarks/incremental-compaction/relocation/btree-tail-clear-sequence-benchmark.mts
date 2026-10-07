// @author: Alec Van Vlerken
// @date: 2026-05-07

import assert from 'assert';
import { performance } from 'node:perf_hooks';

import { BlockNodeStorage } from '../../../src/indexes/btree/nodestorage.mjs';
import {
  DEFAULT_K,
  printScenarioResult,
  runIfMain,
  type ScenarioResult,
  type StepSample,
  writeScenarioArtifacts,
} from '../shared/benchmark-utils.mjs';
import { assertRootOnlyIndexesReadable, createRootOnlyIndexes } from './btree-dominant-tail-blocker-benchmark.mjs';
import {
  allocateFillerBlocks,
  freeFillerBlocks,
  makeTargetFile,
  sampleFile,
} from '../shared/targeted-storage-utils.mjs';

export async function main(): Promise<void> {
  const scenario = 'btree-tail-clear-sequence';
  const file = await makeTargetFile(256);
  const lowFillers = await allocateFillerBlocks(file, 64);
  const storage = new BlockNodeStorage(file);
  const roots = await createRootOnlyIndexes(storage, 24);
  await file.commit();
  await freeFillerBlocks(file, lowFillers);
  await file.commit();

  const before = await sampleFile(file);
  const history: StepSample[] = [];
  let relocatedBtreeNodes = 0;
  let reclaimedTailBlocks = 0;
  const start = performance.now();

  for (let stepNumber = 1; stepNumber <= 4; stepNumber++) {
    const previous = await sampleFile(file);
    const target = roots.sort((a, b) => b.rootBlock - a.rootBlock)[0];
    assert(target);
    const boundary = Math.min(Math.ceil(previous.usedBlocks * DEFAULT_K), target.rootBlock);
    const stepStart = performance.now();
    const relocation = await storage.relocateNode(target.rootBlock, target.rootBlock, { maxBlockExclusive: boundary });
    target.rootBlock = relocation.newRootBlock;
    relocatedBtreeNodes++;
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
      stepRelocatedBtreeNodes: 1,
      stepRelocatedHnswUnits: 0,
      stepReclaimedTailBlocks: reclaimed,
      relocatedDocuments: 0,
      relocatedBtreeNodes,
      relocatedHnswUnits: 0,
      reclaimedTailBlocks,
      ...current,
    });

    if (current.amplification <= DEFAULT_K) break;
  }

  const after = await sampleFile(file);
  await assertRootOnlyIndexesReadable(storage, roots);
  assert(relocatedBtreeNodes > 1);
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
    relocatedBtreeNodes,
    relocatedHnswUnits: 0,
    reclaimedTailBlocks,
    history,
  };

  await writeScenarioArtifacts(result);
  printScenarioResult(result);
}

runIfMain(import.meta.url, main);
