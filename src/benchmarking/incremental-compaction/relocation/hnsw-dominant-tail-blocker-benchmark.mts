// @author: Alec Van Vlerken
// @date: 2026-05-07

import assert from 'assert';
import { performance } from 'node:perf_hooks';

import { DEFAULT_K, printScenarioResult, runIfMain, type ScenarioResult, type StepSample, writeScenarioArtifacts } from '../shared/benchmark-utils.mjs';
import {
  allocateFillerBlocks,
  buildHnswIndex,
  freeFillerBlocks,
  makeTargetFile,
  sampleFile,
  vectorFor,
} from '../shared/targeted-storage-utils.mjs';

export async function main(): Promise<void> {
  const scenario = 'hnsw-dominant-tail-blocker';
  const file = await makeTargetFile(1024);
  const lowFillers = await allocateFillerBlocks(file, 32);
  const index = await buildHnswIndex(file, 42, {
    M: 20,
    maxStoredLevel: 4,
    efConstruction: 64,
    efSearch: 16,
  });
  await file.commit();
  await freeFillerBlocks(file, lowFillers);
  await file.commit();

  const semanticBefore = await index.search(vectorFor(10), 6);
  const before = await sampleFile(file);
  const target = (await index.listRelocationTargets())
    .filter((candidate) => candidate.kind === 'hnsw-graph')
    .sort((a, b) => (b.blockNumber ?? 0) - (a.blockNumber ?? 0))[0];
  assert(target?.nodeId !== undefined && target.blockNumber !== undefined);
  const boundary = Math.min(Math.ceil(before.usedBlocks * DEFAULT_K), target.blockNumber);

  const start = performance.now();
  const stepStart = performance.now();
  await relocateHnswTarget(index, target, boundary);
  await file.commit();
  const reclaimedTailBlocks = (await file.trimFreeTail()).removedBlocks;
  const after = await sampleFile(file);
  const semanticAfter = await index.search(vectorFor(10), 6);

  assert(semanticAfter.some((docId) => semanticBefore.includes(docId)));
  assert(reclaimedTailBlocks > 0);
  assert(after.fileBytes < before.fileBytes);

  const step: StepSample = {
    scenario,
    step: 1,
    didWork: true,
    timeMs: performance.now() - stepStart,
    shrunkBlocksThisStep: before.totalBlocks - after.totalBlocks,
    cumulativeShrunkBytes: before.fileBytes - after.fileBytes,
    stepRelocatedDocuments: 0,
    stepRelocatedBtreeNodes: 0,
    stepRelocatedHnswUnits: 1,
    stepReclaimedTailBlocks: reclaimedTailBlocks,
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

  await writeScenarioArtifacts(result);
  printScenarioResult(result);
}

export async function relocateHnswTarget(
  index: Awaited<ReturnType<typeof buildHnswIndex>>,
  target: { kind: 'hnsw-graph' | 'hnsw-vector'; nodeId?: number; blockNumber?: number },
  maxBlockExclusive: number,
): Promise<void> {
  if (target.nodeId === undefined) {
    throw new Error('HNSW relocation target requires nodeId');
  }
  if (target.kind === 'hnsw-graph') {
    await index.relocateGraphNode(target.nodeId, { maxBlockExclusive });
  } else {
    await index.relocateVectorForNode(target.nodeId, { maxBlockExclusive });
  }
}

runIfMain(import.meta.url, main);
