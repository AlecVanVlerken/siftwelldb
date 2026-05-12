// @author: Alec Van Vlerken
// @date: 2026-05-07

import assert from 'assert';
import { performance } from 'node:perf_hooks';

import { RecordStore } from '../../../dbms/recordstore.mjs';
import { BlockNodeStorage } from '../../../btree/nodestorage.mjs';
import {
  DEFAULT_K,
  makeDocument,
  printScenarioResult,
  runIfMain,
  type ScenarioResult,
  type StepSample,
  writeScenarioArtifacts,
} from '../shared/benchmark-utils.mjs';
import { assertRootOnlyIndexesReadable, createRootOnlyIndexes } from './btree-dominant-tail-blocker-benchmark.mjs';
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
  await runControlledMixedScenario('ordered-mixed-tail-blockers', {
    fillerBlocks: 80,
    treeEntries: 4,
    hnswEntries: 4,
    recordPayloadWords: 900,
    maxSteps: 14,
  });
}

export async function runControlledMixedScenario(
  scenario: string,
  options: {
    fillerBlocks: number;
    treeEntries: number;
    hnswEntries: number;
    recordPayloadWords: number;
    maxSteps: number;
  },
): Promise<ScenarioResult> {
  const file = await makeTargetFile(1024);
  const lowFillers = await allocateFillerBlocks(file, options.fillerBlocks);
  const recordStore = new RecordStore(file);
  let recordPointer = await recordStore.writeRecord(
    makeDocument('items', 'record-tail', {
      group: 'record',
      _payload: 'record tail payload '.repeat(options.recordPayloadWords),
    }),
  );
  const btreeStorage = new BlockNodeStorage(file);
  const btreeRoots = await createRootOnlyIndexes(btreeStorage, options.treeEntries);
  const hnsw = await buildHnswIndex(file, options.hnswEntries, {
    M: 20,
    maxStoredLevel: 4,
    efConstruction: 64,
    efSearch: 16,
  });
  await file.commit();
  await freeFillerBlocks(file, lowFillers);
  await file.commit();

  const semanticBefore = await hnsw.search(vectorFor(3), 6);
  const before = await sampleFile(file);
  const history: StepSample[] = [];
  let relocatedDocuments = 0;
  let relocatedBtreeNodes = 0;
  let relocatedHnswUnits = 0;
  let reclaimedTailBlocks = 0;
  const start = performance.now();

  for (let stepNumber = 1; stepNumber <= options.maxSteps; stepNumber++) {
    const previous = await sampleFile(file);
    const recordBlock = Math.max(...(await recordStore.readRecordBlockChain(recordPointer)));
    const btreeTarget = btreeRoots.sort((a, b) => b.rootBlock - a.rootBlock)[0];
    const hnswTarget = (await hnsw.listRelocationTargets())
      .filter((candidate) => candidate.kind === 'hnsw-graph')
      .sort((a, b) => (b.blockNumber ?? 0) - (a.blockNumber ?? 0))[0];
    const selected = [
      { selectionKind: 'record' as const, blockNumber: recordBlock },
      btreeTarget === undefined
        ? undefined
        : { root: btreeTarget, blockNumber: btreeTarget.rootBlock, selectionKind: 'btree' as const },
      hnswTarget?.blockNumber === undefined ? undefined : { ...hnswTarget, selectionKind: 'hnsw' as const },
    ]
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
      .sort((a, b) => b.blockNumber - a.blockNumber)[0];
    assert(selected);

    const stepStart = performance.now();
    let stepRecords = 0;
    let stepBtree = 0;
    let stepHnsw = 0;
    const boundary = Math.min(Math.ceil(previous.usedBlocks * DEFAULT_K), selected.blockNumber);

    if (selected.selectionKind === 'record') {
      const encoded = await recordStore.readRecordEncoded(recordPointer);
      assert(encoded);
      const newPointer = await recordStore.writeRecordEncodedBelow(encoded, { maxBlockExclusive: boundary });
      assert(newPointer !== null);
      await recordStore.deleteRecord(recordPointer);
      recordPointer = newPointer;
      relocatedDocuments++;
      stepRecords = 1;
    } else if (selected.selectionKind === 'btree') {
      const relocation = await btreeStorage.relocateNode(selected.root.rootBlock, selected.root.rootBlock, {
        maxBlockExclusive: boundary,
      });
      selected.root.rootBlock = relocation.newRootBlock;
      relocatedBtreeNodes++;
      stepBtree = 1;
    } else {
      assert(selected.nodeId !== undefined);
      await relocateHnswTarget(hnsw, selected, boundary);
      relocatedHnswUnits++;
      stepHnsw = 1;
    }

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
      stepRelocatedDocuments: stepRecords,
      stepRelocatedBtreeNodes: stepBtree,
      stepRelocatedHnswUnits: stepHnsw,
      stepReclaimedTailBlocks: reclaimed,
      relocatedDocuments,
      relocatedBtreeNodes,
      relocatedHnswUnits,
      reclaimedTailBlocks,
      ...current,
    });

    const allKindsObserved = relocatedDocuments > 0 && relocatedBtreeNodes > 0 && relocatedHnswUnits > 0;
    if (current.amplification <= DEFAULT_K && allKindsObserved) break;
  }

  const after = await sampleFile(file);
  const semanticAfter = await hnsw.search(vectorFor(3), 6);
  assert(semanticAfter.some((docId) => semanticBefore.includes(docId)));
  assert(await recordStore.readRecord(recordPointer));
  await assertRootOnlyIndexesReadable(btreeStorage, btreeRoots);

  const result: ScenarioResult = {
    scenario,
    status: after.amplification <= DEFAULT_K ? 'converged' : 'plateau-no-safe-progress',
    before,
    after,
    shrunkBlocks: before.totalBlocks - after.totalBlocks,
    shrunkBytes: before.fileBytes - after.fileBytes,
    stepsTaken: history.length,
    timeTakenMs: performance.now() - start,
    relocatedDocuments,
    relocatedBtreeNodes,
    relocatedHnswUnits,
    reclaimedTailBlocks,
    history,
  };

  assert(relocatedDocuments > 0 || relocatedBtreeNodes > 0 || relocatedHnswUnits > 0);
  assert(relocatedBtreeNodes > 0);
  assert(relocatedHnswUnits > 0);
  assert(after.fileBytes < before.fileBytes);
  await writeScenarioArtifacts(result);
  printScenarioResult(result);
  return result;
}

runIfMain(import.meta.url, main);
