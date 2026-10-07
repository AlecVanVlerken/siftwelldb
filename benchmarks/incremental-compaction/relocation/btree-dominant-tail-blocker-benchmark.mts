// @author: Alec Van Vlerken
// @date: 2026-05-07

import assert from 'assert';
import { performance } from 'node:perf_hooks';

import { BPlusTree } from '../../../src/indexes/btree/btree.mjs';
import { BlockInternalNode } from '../../../src/indexes/btree/internalnode.mjs';
import { BlockLeafNode } from '../../../src/indexes/btree/leafnode.mjs';
import { BlockNodeStorage } from '../../../src/indexes/btree/nodestorage.mjs';
import {
  DEFAULT_K,
  printScenarioResult,
  runIfMain,
  type ScenarioResult,
  type StepSample,
  writeScenarioArtifacts,
} from '../shared/benchmark-utils.mjs';
import {
  allocateFillerBlocks,
  freeFillerBlocks,
  makeTargetFile,
  sampleFile,
} from '../shared/targeted-storage-utils.mjs';

export async function main(): Promise<void> {
  const scenario = 'btree-dominant-tail-blocker';
  const file = await makeTargetFile(256);
  const lowFillers = await allocateFillerBlocks(file, 48);
  const storage = new BlockNodeStorage(file);
  const roots = await createRootOnlyIndexes(storage, 18);
  await file.commit();

  await freeFillerBlocks(file, lowFillers);
  await file.commit();

  const before = await sampleFile(file);
  const start = performance.now();
  const history: StepSample[] = [];
  let relocatedBtreeNodes = 0;
  let reclaimedTailBlocks = 0;

  for (let stepNumber = 1; stepNumber <= 8; stepNumber++) {
    const previous = await sampleFile(file);
    const root = roots.sort((a, b) => b.rootBlock - a.rootBlock)[0];
    assert(root);
    const boundary = Math.min(Math.ceil(previous.usedBlocks * DEFAULT_K), root.rootBlock);
    const stepStart = performance.now();
    const relocation = await storage.relocateNode(root.rootBlock, root.rootBlock, { maxBlockExclusive: boundary });
    root.rootBlock = relocation.newRootBlock;
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
  }

  const after = await sampleFile(file);

  await assertRootOnlyIndexesReadable(storage, roots);
  assert(reclaimedTailBlocks > 0);
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

export type RootOnlyIndex = {
  rootBlock: number;
  key: Buffer;
  value: Buffer;
};

export async function createRootOnlyIndexes(storage: BlockNodeStorage, count: number): Promise<RootOnlyIndex[]> {
  const roots: RootOnlyIndex[] = [];
  for (let i = 0; i < count; i++) {
    const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);
    const key = Buffer.from(`idx-${i.toString().padStart(3, '0')}`);
    const value = Buffer.from(`value-${i.toString()}`);
    await tree.insert(key, value);
    roots.push({ rootBlock: tree.getRoot().getBlockNumber(), key, value });
  }
  return roots;
}

export async function assertRootOnlyIndexesReadable(storage: BlockNodeStorage, roots: RootOnlyIndex[]): Promise<void> {
  for (const root of roots) {
    const tree = BPlusTree.open<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(
      storage,
      await storage.openTree(root.rootBlock),
    );
    assert.strictEqual((await tree.get(root.key))?.toString(), root.value.toString());
  }
}
