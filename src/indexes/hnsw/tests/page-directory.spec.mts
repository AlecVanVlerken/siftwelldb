import { describe, expect, it, vi } from 'vitest';
import { AtomicFile } from '../../../storage/wal/atomicfile.mjs';
import { FreeBlockFile } from '../../../storage/blocks/freeblockfile.mjs';
import { MockFile } from '../../../../tests/helpers/mockfile.mjs';
import { HNSWGraphStorage } from '../hnswGraphStorage.mjs';
import { HNSWNode } from '../hnswNode.mjs';
import { BlockReadError } from '../../../storage/blocks/io.mjs';

describe('HNSW page ownership directory', () => {
  it('persists overflow, relocates its metadata and graph pages, and releases every owned block', async () => {
    const data = new MockFile(256),
      log = new MockFile(4096);
    let file = new FreeBlockFile(new AtomicFile(data, log), 256);
    await file.create();
    let graph = await HNSWGraphStorage.create(file, 4, 2, 3);
    let root = graph.metaBlockId;
    let entryPoint = 0;
    for (let i = 0; i < 130; i++) {
      const nodeId = await graph.insertNode(
        new HNSWNode({
          nodeId: 0,
          docId: i,
          level: i === 0 ? 1 : 0,
          vectorPtr: { pageId: 200, slotId: i },
          neighbors: [[]],
          deleted: i % 3 === 0,
        }),
      );
      if (i === 0) entryPoint = nodeId;
    }
    graph.setEntryPoint(entryPoint);
    graph.setCurrentMaxLevel(1);
    expect(graph.metadataBlocks().length).toBeGreaterThan(1);
    for (const blockNumber of graph.metadataBlocks()) {
      const moved = await graph.relocateMetadata({ blockNumber });
      if (blockNumber === root) root = moved!;
      expect(moved).not.toBe(blockNumber);
    }
    const before = [];
    for await (const node of graph.scanNodes()) before.push(node);
    await graph.relocateNode(before[90].nodeId);
    await file.commit();
    await file.close();
    file = new FreeBlockFile(new AtomicFile(data, log), 256);
    await file.open();
    graph = await HNSWGraphStorage.open(file, root);
    expect(graph.entryPoint).toBe(entryPoint);
    expect(graph.currentMaxLevel).toBe(1);
    const nodes = [];
    for await (const node of graph.scanNodes()) nodes.push(node);
    expect(nodes.map((node) => node.docId).sort((a, b) => a - b)).toEqual(Array.from({ length: 130 }, (_, i) => i));
    expect(nodes.filter((node) => node.deleted)).toHaveLength(44);
    for (const node of nodes) await graph.hardDeleteNode(node.nodeId);
    await graph.freeMetadataBlock();
    await file.commit();
    expect((await file.getStats()).usedBlocks).toBe(1);
    await file.close();
  });

  it('rejects corrupt directory counts instead of reconstructing incomplete membership', async () => {
    const file = new FreeBlockFile(new AtomicFile(new MockFile(4096), new MockFile(4096)), 4096);
    await file.create();
    const graph = await HNSWGraphStorage.create(file, 4, 2, 3);
    const raw = await file.readBlock(graph.metaBlockId);
    raw.writeUInt16LE(1, 39);
    await file.writeBlock(graph.metaBlockId, raw.subarray(1));
    await expect(HNSWGraphStorage.open(file, graph.metaBlockId)).rejects.toThrow(/count mismatch/);
    await file.close();
  });

  it('propagates directory I/O failures even when their messages contain HNSW', async () => {
    const file = new FreeBlockFile(new AtomicFile(new MockFile(4096), new MockFile(4096)), 4096);
    await file.create();
    const graph = await HNSWGraphStorage.create(file, 4, 2, 3);
    const overflow = await file.allocateBlock();
    const raw = await file.readBlock(graph.metaBlockId);
    raw.writeUInt32LE(overflow, 35);
    await file.writeBlock(graph.metaBlockId, raw.subarray(1));
    const failure = new BlockReadError(overflow, new Error('HNSW directory read failed'));
    const originalRead = file.readBlock.bind(file);
    const read = vi
      .spyOn(file, 'readBlock')
      .mockImplementation((block) => (block === overflow ? Promise.reject(failure) : originalRead(block)));
    try {
      await expect(HNSWGraphStorage.open(file, graph.metaBlockId)).rejects.toBe(failure);
    } finally {
      read.mockRestore();
      await file.close();
    }
  });
});
