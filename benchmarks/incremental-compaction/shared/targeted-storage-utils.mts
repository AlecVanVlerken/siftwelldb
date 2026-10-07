// @author: Alec Van Vlerken
// @date: 2026-05-07

import assert from 'assert';

import { AtomicFile } from '../../../src/storage/wal/atomicfile.mjs';
import { BPlusTree } from '../../../src/indexes/btree/btree.mjs';
import { BlockInternalNode } from '../../../src/indexes/btree/internalnode.mjs';
import { BlockLeafNode } from '../../../src/indexes/btree/leafnode.mjs';
import { BlockNodeStorage } from '../../../src/indexes/btree/nodestorage.mjs';
import { MockFile } from '../../../tests/helpers/mockfile.mjs';
import { FreeBlockFile } from '../../../src/storage/blocks/freeblockfile.mjs';
import { HNSWGraphStorage } from '../../../src/indexes/hnsw/hnswGraphStorage.mjs';
import { HNSWIndex } from '../../../src/indexes/hnsw/hnswIndex.mjs';
import { VectorHeapFile } from '../../../src/indexes/hnsw/vectorHeapFile.mjs';
import type { StorageSample } from './benchmark-utils.mjs';

export type BlockTree = BPlusTree<Buffer, Buffer, BlockLeafNode, BlockInternalNode>;

export async function makeTargetFile(blockSize = 256): Promise<FreeBlockFile> {
  const data = new MockFile(blockSize);
  const log = new MockFile(blockSize * 16);
  const file = new FreeBlockFile(new AtomicFile(data, log), blockSize);
  await file.create();
  return file;
}

export async function allocateFillerBlocks(file: FreeBlockFile, count: number): Promise<number[]> {
  const blocks: number[] = [];
  for (let i = 0; i < count; i++) {
    blocks.push(await file.allocateBlock());
  }
  return blocks;
}

export async function freeFillerBlocks(file: FreeBlockFile, blocks: number[]): Promise<void> {
  for (const block of blocks) {
    await file.freeBlock(block);
  }
}

export async function sampleFile(file: FreeBlockFile): Promise<StorageSample> {
  const stats = await file.getStats();
  return {
    totalBlocks: stats.totalBlocks,
    usedBlocks: stats.usedBlocks,
    freeBlocks: stats.freeBlocks,
    amplification: stats.totalBlocks / Math.max(1, stats.usedBlocks),
    fileBytes: stats.fileSizeBytes,
  };
}

export async function buildTree(
  file: FreeBlockFile,
  count: number,
): Promise<{ storage: BlockNodeStorage; tree: BlockTree; rootBlock: number }> {
  const storage = new BlockNodeStorage(file);
  const tree = await BPlusTree.create<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(storage);
  for (let i = 0; i < count; i++) {
    await tree.insert(treeKey(i), Buffer.from(`value-${i.toString()}`));
  }
  return { storage, tree, rootBlock: tree.getRoot().getBlockNumber() };
}

export async function assertTreeReadable(storage: BlockNodeStorage, rootBlock: number, count: number): Promise<void> {
  const reopened = BPlusTree.open<Buffer, Buffer, BlockLeafNode, BlockInternalNode>(
    storage,
    await storage.openTree(rootBlock),
  );
  for (let i = 0; i < count; i++) {
    assert.strictEqual((await reopened.get(treeKey(i)))?.toString(), `value-${i.toString()}`);
  }
}

export type HnswBenchmarkOptions = {
  dimension?: number;
  M?: number;
  maxStoredLevel?: number;
  efConstruction?: number;
  efSearch?: number;
};

export async function buildHnswIndex(
  file: FreeBlockFile,
  count: number,
  options: HnswBenchmarkOptions = {},
): Promise<HNSWIndex> {
  const dimension = options.dimension ?? 4;
  const M = options.M ?? 4;
  const graph = await HNSWGraphStorage.create(file, M, options.maxStoredLevel ?? 3);
  const heap = new VectorHeapFile(file, dimension);
  const index = HNSWIndex.create(graph, heap, {
    M,
    efConstruction: options.efConstruction ?? 16,
    efSearch: options.efSearch ?? 8,
  });
  for (let i = 0; i < count; i++) {
    await index.insert(i + 1, vectorForDimension(i, dimension));
  }
  return index;
}

export function vectorFor(seed: number): Float32Array {
  return vectorForDimension(seed, 4);
}

export function vectorForDimension(seed: number, dimension: number): Float32Array {
  const vector = new Float32Array(dimension);
  for (let i = 0; i < dimension; i++) {
    vector[i] = ((seed + i * 17) % 29) + 1;
  }
  return vector;
}

function treeKey(value: number): Buffer {
  return Buffer.from(value.toString().padStart(5, '0'));
}
