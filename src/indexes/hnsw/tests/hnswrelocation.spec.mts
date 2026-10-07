import assert from 'assert';
import { describe, it } from 'vitest';

import { AtomicFile } from '../../../storage/wal/atomicfile.mjs';
import { MockFile } from '../../../../tests/helpers/mockfile.mjs';
import { FreeBlockFile } from '../../../storage/blocks/freeblockfile.mjs';
import { HNSWGraphStorage } from '../hnswGraphStorage.mjs';
import { HNSWNode } from '../hnswNode.mjs';
import { VectorHeapFile, type VectorPointer } from '../vectorHeapFile.mjs';

async function makeFbf(blockSize: number): Promise<FreeBlockFile> {
  const data = new MockFile(blockSize);
  const log = new MockFile(blockSize * 16);
  const file = new FreeBlockFile(new AtomicFile(data, log), blockSize);
  await file.create();
  return file;
}

function vector(...values: number[]): Float32Array {
  return new Float32Array(values);
}

function assertVectorEquals(actual: Float32Array, expected: Float32Array): void {
  assert.strictEqual(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) {
    assert(Math.abs(actual[i] - expected[i]) < 0.00001);
  }
}

function makeNode(overrides: Partial<HNSWNode> = {}): HNSWNode {
  return new HNSWNode({
    nodeId: 0,
    docId: 1,
    level: 0,
    vectorPtr: { pageId: 2, slotId: 0 },
    neighbors: [[]],
    deleted: false,
    ...overrides,
  });
}

describe('HNSW relocation storage primitives', () => {
  it('relocates a graph node and repairs entry point and neighbor references', async () => {
    const fbf = await makeFbf(1024);
    const graph = await HNSWGraphStorage.create(fbf, 4, 2);
    const metaBlockId = graph.metaBlockId;

    const first = makeNode({ docId: 10, level: 1, neighbors: [[], []] });
    await graph.insertNode(first);
    const second = makeNode({
      docId: 20,
      level: 1,
      neighbors: [[first.nodeId], [first.nodeId]],
    });
    await graph.insertNode(second);
    graph.setEntryPoint(first.nodeId);
    graph.setCurrentMaxLevel(1);
    await graph.saveMetadata();

    const oldNodeId = first.nodeId;
    const result = await graph.relocateNode(oldNodeId);

    assert.notStrictEqual(result.newNodeId, oldNodeId);
    await assert.rejects(() => graph.getNode(oldNodeId));
    assert.strictEqual(graph.entryPoint, result.newNodeId);

    const relocated = await graph.getNode(result.newNodeId);
    assert.strictEqual(relocated.docId, 10);
    const updatedSecond = await graph.getNode(second.nodeId);
    assert.deepStrictEqual(updatedSecond.neighbors[0], [result.newNodeId]);
    assert.deepStrictEqual(updatedSecond.neighbors[1], [result.newNodeId]);

    await fbf.commit();
    const reopened = await HNSWGraphStorage.open(fbf, metaBlockId);
    assert.strictEqual(reopened.entryPoint, result.newNodeId);
    const reopenedSecond = await reopened.getNode(second.nodeId);
    assert.deepStrictEqual(reopenedSecond.neighbors[0], [result.newNodeId]);
  });

  it('rejects relocation of deleted graph nodes', async () => {
    const fbf = await makeFbf(1024);
    const graph = await HNSWGraphStorage.create(fbf, 4, 2);

    const deleted = makeNode({ docId: 30, level: 1, deleted: true, neighbors: [[], []] });
    await graph.insertNode(deleted);
    const live = makeNode({
      docId: 20,
      level: 1,
      neighbors: [[deleted.nodeId], [deleted.nodeId]],
    });
    await graph.insertNode(live);
    graph.setEntryPoint(live.nodeId);
    graph.setCurrentMaxLevel(1);
    await graph.saveMetadata();

    await assert.rejects(() => graph.relocateNode(deleted.nodeId), /cannot relocate deleted node/);
    assert.strictEqual(graph.entryPoint, live.nodeId);
    assert.deepStrictEqual((await graph.getNode(live.nodeId)).neighbors[0], [deleted.nodeId]);
  });

  it('relocates a vector slot and frees the old location', async () => {
    const fbf = await makeFbf(256);
    const heap = new VectorHeapFile(fbf, 4);
    const stored = vector(1, 2, 3, 4);
    const oldPtr: VectorPointer = await heap.insert(stored);

    const newPtr = await heap.relocate(oldPtr);

    assert.notDeepStrictEqual(newPtr, oldPtr);
    await assert.rejects(() => heap.get(oldPtr));
    assertVectorEquals(await heap.get(newPtr), stored);
  });
});
