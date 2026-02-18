// hnsw/hnswIndex.ts

import { VectorHeapFile } from './vectorHeapFile.mjs';
import { HNSWNode, type NodeId } from './hnswNode.mjs';
import { type SearchContext, HNSWSearch } from './hnswSearch.mjs';
import { type InsertContext, HNSWInsert } from './hnswInsert.mjs';
import { type DeleteContext, HNSWDelete } from './hnswDelete.mjs';
import { HNSWGraphStorage } from './hnswGraphStorage.mjs';

export type DistanceFn = (a: Float32Array, b: Float32Array) => number;

/** Squared Euclidean distance (default). */
export function squaredL2(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return sum;
}

export type HNSWParams = {
  M: number;
  efConstruction: number;
  efSearch: number;
  distanceFn?: DistanceFn;
};

/**
 * HNSWIndex
 * ----------
 * Top-level entry point for the HNSW approximate nearest-neighbour index.
 *
 * Mirrors the `BPlusTree` lifecycle exactly:
 *
 *   // ── Creating a new index ─────────────────────────────────────────
 *   const graphFbf  = new FreeBlockFile(atomicFile1, blockSize);
 *   const vectorFbf = new FreeBlockFile(atomicFile2, blockSize);
 *   await graphFbf.create();   await graphFbf.open();
 *   await vectorFbf.create();  await vectorFbf.open();
 *
 *   const graphStorage = await HNSWGraphStorage.create(graphFbf, M, maxStoredLevel);
 *   const vectorHeap   = new VectorHeapFile(vectorFbf, dimension);
 *   const index = HNSWIndex.create(graphStorage, vectorHeap, { M, efConstruction, efSearch });
 *
 *   await index.insert(docId, vector);
 *   await graphFbf.commit();   // persist graph blocks atomically
 *   await vectorFbf.commit();  // persist vector blocks atomically
 *
 *   await graphFbf.close();
 *   await vectorFbf.close();
 *
 *   // ── Reopening an existing index ──────────────────────────────────
 *   await graphFbf.open();
 *   await vectorFbf.open();
 *
 *   const graphStorage = await HNSWGraphStorage.open(graphFbf);
 *   const vectorHeap   = new VectorHeapFile(vectorFbf, dimension);
 *   const index = await HNSWIndex.open(graphStorage, vectorHeap, { efSearch });
 *
 *   const results = await index.search(queryVec, k);
 *
 *   await graphFbf.close();
 *   await vectorFbf.close();
 */
// InsertContext already extends SearchContext, so listing SearchContext here
// is redundant. Removing it avoids a circular-self-reference that confuses
// the TypeScript checker when `this` is passed to `new HNSWInsert(this, ...)`.
export class HNSWIndex implements InsertContext, DeleteContext {
  private readonly inserter: HNSWInsert;
  private readonly searcher: HNSWSearch;
  private readonly deleter: HNSWDelete;
  private readonly distanceFn: DistanceFn;

  /**
   * In-memory reverse index: docId → NodeId.
   * Rebuilt from disk on `open()` by scanning graph storage.
   * Updated incrementally by `insert()` and `delete()`.
   */
  private readonly docIdIndex = new Map<number, NodeId>();

  // Private constructor — use the static factory methods.
  private constructor(
    private readonly graphStorage: HNSWGraphStorage,
    private readonly vectorHeap: VectorHeapFile,
    efConstruction: number,
    efSearch: number,
    distanceFn: DistanceFn,
  ) {
    this.distanceFn = distanceFn;
    this.inserter = new HNSWInsert(this as InsertContext, graphStorage.M, efConstruction);
    this.searcher = new HNSWSearch(this as SearchContext, efSearch);
    this.deleter = new HNSWDelete(this as DeleteContext);
  }

  // ── Factory methods ───────────────────────────────────────────────────────

  /**
   * Create a new (empty) `HNSWIndex` on top of a freshly-initialised
   * `HNSWGraphStorage` and `VectorHeapFile`.
   *
   * The storage objects must already be constructed; this method only wires
   * them together and returns the index (just like `BPlusTree.create(storage)`).
   */
  static create(graphStorage: HNSWGraphStorage, vectorHeap: VectorHeapFile, params: HNSWParams): HNSWIndex {
    const { efConstruction, efSearch, distanceFn = squaredL2 } = params;
    return new HNSWIndex(graphStorage, vectorHeap, efConstruction, efSearch, distanceFn);
  }

  /**
   * Open an `HNSWIndex` from an existing `HNSWGraphStorage`.
   *
   * Reads `M`, `maxStoredLevel`, entry point, and current max level from the
   * graph storage's persisted metadata (already loaded by
   * `HNSWGraphStorage.open(fbf)`), then rebuilds the `docId → NodeId` map by
   * scanning all live nodes (analogous to `BPlusTree.open(storage, root)`).
   */
  static async open(
    graphStorage: HNSWGraphStorage,
    vectorHeap: VectorHeapFile,
    params: Pick<HNSWParams, 'efSearch' | 'distanceFn'> & { efConstruction?: number },
  ): Promise<HNSWIndex> {
    const { efSearch, distanceFn = squaredL2, efConstruction = graphStorage.M * 2 } = params;
    const index = new HNSWIndex(graphStorage, vectorHeap, efConstruction, efSearch, distanceFn);
    await index.rebuildDocIdIndex();
    return index;
  }

  // ── Public index operations ───────────────────────────────────────────────

  /**
   * Insert a vector associated with `docId` into the index.
   * Throws if `docId` is already present.
   *
   * After one or more inserts, call `graphFbf.commit()` and `vectorFbf.commit()`
   * to durably persist all changes to disk.
   */
  async insert(docId: number, vector: Float32Array): Promise<void> {
    if (this.docIdIndex.has(docId)) {
      throw new Error(`HNSWIndex: docId ${docId} already exists. Use delete() first to replace it.`);
    }

    // 1. Persist the raw vector in the heap file.
    const vectorPtr = await this.vectorHeap.insert(vector);

    // 2. Allocate a graph node slot.
    const level = this.inserter.randomLevel(this.graphStorage.maxStoredLevel);
    const node = new HNSWNode({
      nodeId: 0n, // assigned by insertNode below
      docId,
      level,
      vectorPtr,
      neighbors: [],
      deleted: false,
    });
    await this.graphStorage.insertNode(node); // sets node.nodeId

    // 3. Wire the node into the HNSW graph layers.
    const { entryPoint: newEp, maxLevel: newMaxLevel } = await this.inserter.insert(
      this.graphStorage.entryPoint,
      this.graphStorage.currentMaxLevel,
      node,
      vector,
    );

    // 4. Persist updated graph-level metadata to the dirty cache.
    this.graphStorage.setEntryPoint(newEp);
    this.graphStorage.setCurrentMaxLevel(newMaxLevel);
    await this.graphStorage.saveMetadata();

    // 5. Update in-memory reverse index.
    this.docIdIndex.set(docId, node.nodeId);
  }

  /**
   * Search for the `k` nearest neighbours of `queryVector`.
   * Returns docIds sorted by ascending distance (closest first).
   * Returns an empty array if the index is empty.
   */
  async search(queryVector: Float32Array, k: number): Promise<number[]> {
    const ep = this.graphStorage.entryPoint;
    if (ep === null) return [];

    const nodeIds = await this.searcher.search(ep, this.graphStorage.currentMaxLevel, queryVector, k);

    // Map NodeIds → docIds, filtering out any soft-deleted nodes.
    const result: number[] = [];
    for (const nid of nodeIds) {
      const node = await this.graphStorage.getNode(nid);
      if (!node.deleted) result.push(node.docId);
    }
    return result;
  }

  /**
   * Soft-delete the node associated with `docId` from the index.
   * If `docId` is not in the index this is a no-op.
   *
   * After deletion, call `graphFbf.commit()` and `vectorFbf.commit()` to flush.
   */
  async delete(docId: number): Promise<void> {
    const nodeId = this.docIdIndex.get(docId);
    if (nodeId === undefined) return;

    // Free the vector storage slot.
    const node = await this.graphStorage.getNode(nodeId);
    await this.vectorHeap.delete(node.vectorPtr);

    // Soft-delete from the graph (marks deleted, removes back-links).
    const { entryPoint: newEp, maxLevel: newMaxLevel } = await this.deleter.softDelete(
      nodeId,
      this.graphStorage.entryPoint,
      this.graphStorage.currentMaxLevel,
    );

    // Persist updated metadata to the dirty cache.
    this.graphStorage.setEntryPoint(newEp);
    this.graphStorage.setCurrentMaxLevel(newMaxLevel);
    await this.graphStorage.saveMetadata();

    this.docIdIndex.delete(docId);
  }

  // ── Context interface implementations ─────────────────────────────────────

  async getNode(nodeId: NodeId): Promise<HNSWNode> {
    return this.graphStorage.getNode(nodeId);
  }

  async getVector(nodeId: NodeId): Promise<Float32Array> {
    const node = await this.graphStorage.getNode(nodeId);
    return this.vectorHeap.get(node.vectorPtr);
  }

  computeDistance(a: Float32Array, b: Float32Array): number {
    return this.distanceFn(a, b);
  }

  async saveNode(node: HNSWNode): Promise<void> {
    await this.graphStorage.saveNode(node);
  }

  async hardDeleteNode(nodeId: NodeId): Promise<void> {
    await this.graphStorage.hardDeleteNode(nodeId);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Scan all pages in the graph storage and rebuild the `docId → NodeId` map.
   * Called once during `open()`.
   */
  private async rebuildDocIdIndex(): Promise<void> {
    this.docIdIndex.clear();
    for await (const node of this.graphStorage.scanNodes()) {
      if (!node.deleted) {
        this.docIdIndex.set(node.docId, node.nodeId);
      }
    }
  }
}
