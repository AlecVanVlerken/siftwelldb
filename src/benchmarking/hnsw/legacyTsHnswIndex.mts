import { HNSWGraphStorage } from '../../hnsw/hnswGraphStorage.mjs';
import type { HnswIndexNative } from '../../hnsw/hnswNative.mjs';
import { HNSWNode, type NodeId } from '../../hnsw/hnswNode.mjs';
import { VectorHeapFile, type VectorPointer } from '../../hnsw/vectorHeapFile.mjs';
import { LegacyTsCore } from './legacyTsCore.mjs';

export type DistanceFn = (a: Float32Array, b: Float32Array) => number;

export function squaredL2(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return sum;
}

export type LegacyTsHNSWParams = {
  M: number;
  efConstruction: number;
  efSearch: number;
  distanceFn?: DistanceFn;
};

export class LegacyTsHNSWIndex {
  private readonly core: LegacyTsCore;
  private readonly docIdIndex = new Map<number, NodeId>();
  private readonly vectorPtrCache = new Map<number, VectorPointer>();

  private constructor(
    private readonly graphStorage: HNSWGraphStorage,
    private readonly vectorHeap: VectorHeapFile,
    M: number,
    efConstruction: number,
    efSearch: number,
  ) {
    this.core = new LegacyTsCore(vectorHeap.dimension, M, efConstruction, efSearch);
  }

  static create(
    graphStorage: HNSWGraphStorage,
    vectorHeap: VectorHeapFile,
    params: LegacyTsHNSWParams,
  ): LegacyTsHNSWIndex {
    const { M, efConstruction, efSearch } = params;
    return new LegacyTsHNSWIndex(graphStorage, vectorHeap, M, efConstruction, efSearch);
  }

  async insert(docId: number, vector: Float32Array): Promise<void> {
    if (this.docIdIndex.has(docId)) {
      throw new Error(`LegacyTsHNSWIndex: docId ${docId} already exists. Use delete() first to replace it.`);
    }

    const vectorPtr = await this.vectorHeap.insert(vector);
    this.core.insert(docId, vector);

    const dirtyDocIds = this.core.takeDirtyNodes();
    const newLevel = Math.min(this.core.getLevel(docId), this.graphStorage.maxStoredLevel);
    const newNeighbors = this.buildNeighborList(docId, newLevel);
    const node = new HNSWNode({
      nodeId: 0,
      docId,
      level: newLevel,
      vectorPtr,
      neighbors: newNeighbors,
      deleted: false,
    });

    await this.graphStorage.insertNode(node);
    this.graphStorage.incrementLevel(newLevel);
    this.docIdIndex.set(docId, node.nodeId);
    this.vectorPtrCache.set(docId, vectorPtr);

    for (const dirtyDocId of dirtyDocIds) {
      if (dirtyDocId === docId) continue;
      const nodeId = this.docIdIndex.get(dirtyDocId);
      if (nodeId === undefined) continue;
      const pending = this.graphStorage.updateNodeNeighbors(
        nodeId,
        dirtyDocId,
        this.core as unknown as HnswIndexNative,
        this.docIdIndex,
      );
      if (pending !== undefined) await pending;
    }

    const entryDocId = this.core.getEntryDocId();
    const newEntryPoint = entryDocId !== null ? (this.docIdIndex.get(entryDocId) ?? null) : null;
    const newMaxLevel = this.core.getMaxLevel();
    this.graphStorage.setEntryPoint(newEntryPoint);
    this.graphStorage.setCurrentMaxLevel(Math.max(newMaxLevel, this.graphStorage.computedMaxLevel()));
    await this.graphStorage.saveMetadata();
  }

  async search(queryVector: Float32Array, k: number): Promise<number[]> {
    return Promise.resolve(this.core.search(queryVector, k));
  }

  async delete(docId: number): Promise<void> {
    const nodeId = this.docIdIndex.get(docId);
    if (nodeId === undefined) return;

    const level = this.core.getLevel(docId);
    const vectorPtr = this.vectorPtrCache.get(docId);
    if (vectorPtr !== undefined) {
      await this.vectorHeap.delete(vectorPtr);
    } else {
      const node = await this.graphStorage.getNode(nodeId);
      await this.vectorHeap.delete(node.vectorPtr);
    }

    if (level >= 0) this.graphStorage.decrementLevel(level);

    this.core.delete(docId);
    const dirtyDocIds = this.core.takeDirtyNodes();

    await this.graphStorage.hardDeleteNode(nodeId);
    this.docIdIndex.delete(docId);
    this.vectorPtrCache.delete(docId);

    for (const dirtyDocId of dirtyDocIds) {
      const neighborNodeId = this.docIdIndex.get(dirtyDocId);
      if (neighborNodeId === undefined) continue;
      const pending = this.graphStorage.updateNodeNeighbors(
        neighborNodeId,
        dirtyDocId,
        this.core as unknown as HnswIndexNative,
        this.docIdIndex,
      );
      if (pending !== undefined) await pending;
    }

    const entryDocId = this.core.getEntryDocId();
    const newEntryPoint = entryDocId !== null ? (this.docIdIndex.get(entryDocId) ?? null) : null;
    const correctMaxLevel = newEntryPoint !== null ? this.graphStorage.computedMaxLevel() : 0;
    this.graphStorage.setEntryPoint(newEntryPoint);
    this.graphStorage.setCurrentMaxLevel(correctMaxLevel);
    await this.graphStorage.saveMetadata();
  }

  async commit(): Promise<void> {
    await this.vectorHeap.commit();
    await this.graphStorage.commit();
  }

  async close(): Promise<void> {
    await this.vectorHeap.close();
    await this.graphStorage.close();
  }

  private buildNeighborList(docId: number, level: number): NodeId[][] {
    const allNeighbors = this.core.getAllNeighbors(docId);
    const neighbors: NodeId[][] = [];
    let position = 1;
    for (let layer = 0; layer <= level; layer++) {
      const layerNodeIds: NodeId[] = [];
      if (position < allNeighbors.length) {
        const count = allNeighbors[position++];
        for (let index = 0; index < count; index++) {
          const nodeId = this.docIdIndex.get(allNeighbors[position + index]);
          if (nodeId !== undefined) layerNodeIds.push(nodeId);
        }
        position += count;
      }
      neighbors.push(layerNodeIds);
    }
    return neighbors;
  }
}
