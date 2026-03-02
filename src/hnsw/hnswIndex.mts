//@author: Thomas Dumon with usage of Claude sonnet 4.6
//@date: 2026-02-18

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
 * **STORAGE MODEL**
 * Both graph nodes (HNSWGraphStorage, magic 0xa3) and raw vectors
 * (VectorHeapFile, magic 0xa5) share the single FreeBlockFile owned by
 * DbmsBack.  All dirty pages — from both storage objects — are flushed by
 * one WAL commit.  In normal usage `DbmsBack.commit()` handles this
 * automatically; `HNSWIndex.commit()` is provided only for standalone
 * use (e.g. unit tests that construct an index without DbmsBack).
 *
 * **CRASH-CONSISTENCY MODEL**
 * In-memory writes are always ordered: vectors are written BEFORE graph
 * connections ("data before index" rule).  This ensures the graph only
 * ever references vector slots that actually exist on disk:
 *
 *   • Vector written, graph not yet wired → orphaned vector slot at worst;
 *       the graph remains fully consistent.  (Recoverable by a GC scan.)
 *
 *   • Graph wired, vector not yet written → dangling vectorPtr reference,
 *       silent corruption on reopen.  NEVER allow this order.
 *
 *   // ** NORMAL USAGE (through DbmsBack) **
 *   //  DbmsBack creates/opens graph storage and vector heap internally.
 *   //  All commits go through db.commit() — never call index.commit().
 *   await db.insert(collection, document);   // internally calls index.insert()
 *   await db.commit();                       // freeblockFile.commit() covers everything
 *
 *   // ** STANDALONE USAGE (e.g. unit tests) **
 *   //  (sharedFbf is a FreeBlockFile you manage yourself)
 *   const graphStorage = await HNSWGraphStorage.create(sharedFbf, M, maxStoredLevel);
 *   const vectorHeap   = new VectorHeapFile(sharedFbf, dimension);
 *   const index = HNSWIndex.create(graphStorage, vectorHeap, { M, efConstruction, efSearch });
 *
 *   await index.insert(docId, vector);
 *   await index.commit();   // flush sharedFbf WAL — only needed in standalone mode
 *   await index.close();
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

  // ** Static factory methods **

  /**
   * Create a new (empty) `HNSWIndex` on top of a freshly-initialised
   * `HNSWGraphStorage` and `VectorHeapFile`.
   *
   * The storage objects must already be constructed; this method only wires
   * them together and returns the index.
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
   * `HNSWGraphStorage.open(sharedFbf, metaBlockId)`), then rebuilds the
   * `docId → NodeId` map by scanning all node slots and filtering for live
   * (non-deleted) ones (analogous to `BPlusTree.open(storage, root)`).
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

  // ** PUBLIC INDEX API **

  /**
   * Insert a vector associated with `docId` into the index.
   * Throws if `docId` is already present.
   *
   * Changes are buffered in-memory until the next commit.  In normal usage
   * `DbmsBack.commit()` handles flushing.  In standalone mode call
   * `index.commit()` (or `sharedFbf.commit()`) directly.
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
    // Track this node in the level histogram before wiring.
    this.graphStorage.incrementLevel(level);

    // 3. Wire the node into the HNSW graph layers.
    const { entryPoint: newEp, maxLevel: newMaxLevel } = await this.inserter.insert(
      this.graphStorage.entryPoint,
      this.graphStorage.currentMaxLevel,
      node,
      vector,
    );

    // 4. Persist updated graph-level metadata to the dirty cache.
    //    Use the histogram-derived max level — it is always correct even if the
    //    inserter returns a stale value.
    this.graphStorage.setEntryPoint(newEp);
    this.graphStorage.setCurrentMaxLevel(Math.max(newMaxLevel, this.graphStorage.computedMaxLevel()));
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
   * Changes are buffered in-memory until the next commit.  In normal usage
   * `DbmsBack.commit()` handles flushing.  In standalone mode call
   * `index.commit()` (or `sharedFbf.commit()`) directly.
   */
  async delete(docId: number): Promise<void> {
    const nodeId = this.docIdIndex.get(docId);
    if (nodeId === undefined) return;

    // Free the vector storage slot.
    const node = await this.graphStorage.getNode(nodeId);
    await this.vectorHeap.delete(node.vectorPtr);

    // Remove this node from the level histogram BEFORE soft-delete so that
    // computedMaxLevel() reflects the state after deletion.
    this.graphStorage.decrementLevel(node.level);

    // Soft-delete from the graph (marks deleted, removes back-links).
    const { entryPoint: newEp } = await this.deleter.softDelete(
      nodeId,
      this.graphStorage.entryPoint,
      this.graphStorage.currentMaxLevel,
    );

    // Derive the authoritative max level from the histogram — this is always
    // correct, unlike the approximation previously returned by softDelete.
    const correctMaxLevel = newEp !== null ? this.graphStorage.computedMaxLevel() : 0;

    // Persist updated metadata to the dirty cache.
    this.graphStorage.setEntryPoint(newEp);
    this.graphStorage.setCurrentMaxLevel(correctMaxLevel);
    await this.graphStorage.saveMetadata();

    this.docIdIndex.delete(docId);
  }

  // ** context interface implementations for inserter, searcher, deleter **

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

  // ** persistance API for standalone use (not needed when using through DbmsBack) **

  /**
   * Flush all pending changes to disk via the shared FreeBlockFile WAL.
   *
   * **In normal usage this method is never called directly.**
   * `DbmsBack.commit()` flushes `freeblockFile` directly, which covers
   * all subsystems (records, B+ trees, HNSW graph, HNSW vectors) in one
   * atomic operation.
   *
   * This method exists for standalone use (e.g. unit tests that construct
   * an `HNSWIndex` without `DbmsBack`).  It preserves the "data before
   * index" in-memory write order: vector heap is committed first, graph
   * storage second.
   */
  async commit(): Promise<void> {
    await this.vectorHeap.commit(); // data first
    await this.graphStorage.commit(); // index second
  }

  /**
   * Release any open handles held by the storage objects.
   * Always call commit() before close() to ensure the latest changes are
   * durable.  Note: since both objects share one FreeBlockFile (owned by
   * DbmsBack), the actual file descriptor is closed by DbmsBack.close(),
   * not here.
   */
  async close(): Promise<void> {
    await this.vectorHeap.close();
    await this.graphStorage.close();
  }

  // **private helpers**

  /**
   * Scan all pages in the graph storage and rebuild the `docId → NodeId` map.
   * Called once during `open()`.
   */
  private async rebuildDocIdIndex(): Promise<void> {
    this.docIdIndex.clear();
    this.graphStorage.resetHistogram();
    for await (const node of this.graphStorage.scanNodes()) {
      // scanNodes() yields ALL slots (including deleted) — see note in graphStorage.
      // We always count deleted nodes too, since decrementLevel() is called at
      // delete-time; but soft-deleted nodes were already counted and then
      // decremented. Here we only rebuild for live nodes.
      if (!node.deleted) {
        this.docIdIndex.set(node.docId, node.nodeId);
        this.graphStorage.incrementLevel(node.level);
      }
    }
  }
}
