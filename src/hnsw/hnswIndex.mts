//@author: Thomas Dumon with usage of Claude sonnet 4.6
//@date: 2026-02-18

import { VectorHeapFile, type VectorPointer } from './vectorHeapFile.mjs';
import { HNSWNode, type NodeId } from './hnswNode.mjs';
import { HNSWGraphStorage } from './hnswGraphStorage.mjs';
import { HnswIndexNative } from './hnswNative.mjs';

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
 * **IMPLEMENTATION**
 * This implementation uses a Rust native DLL (via `HnswIndexNative`) for all
 * graph computation (insert, search, delete) while keeping `HNSWGraphStorage`
 * and `VectorHeapFile` for crash-consistent WAL-backed persistence.
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
 * connections ("data before index" rule).
 *
 * **PERFORMANCE**
 * All graph traversal (beam search, heuristic neighbor selection, SIMD L2
 * distance) runs synchronously in Rust.  After each insert/delete, only
 * the O(M × maxLevel) modified nodes are written back to FBF.
 */
export class HNSWIndex {
  private readonly rustIdx: HnswIndexNative;

  /**
   * In-memory reverse index: docId → NodeId.
   * Rebuilt from disk on `open()` by scanning graph storage.
   * Updated incrementally by `insert()` and `delete()`.
   */
  private readonly docIdIndex = new Map<number, NodeId>();

  /**
   * Cache of docId → VectorPointer so we can free vectors on delete
   * without a FBF round-trip.
   */
  private readonly vectorPtrCache = new Map<number, VectorPointer>();

  // Private constructor — use the static factory methods.
  private constructor(
    private readonly graphStorage: HNSWGraphStorage,
    private readonly vectorHeap: VectorHeapFile,
    M: number,
    efConstruction: number,
    efSearch: number,
  ) {
    this.rustIdx = new HnswIndexNative(vectorHeap.dimension, M, efConstruction, efSearch);
  }

  // ** Static factory methods **

  /**
   * Create a new (empty) `HNSWIndex` on top of a freshly-initialised
   * `HNSWGraphStorage` and `VectorHeapFile`.
   */
  static create(graphStorage: HNSWGraphStorage, vectorHeap: VectorHeapFile, params: HNSWParams): HNSWIndex {
    const { M, efConstruction, efSearch } = params;
    return new HNSWIndex(graphStorage, vectorHeap, M, efConstruction, efSearch);
  }

  /**
   * Open an `HNSWIndex` from an existing `HNSWGraphStorage`.
   *
   * Bulk-loads all persisted nodes from FBF into the Rust in-memory index,
   * restoring the full graph structure. Two passes over the stored nodes are
   * required: one to import node data, one to wire neighbor connections.
   */
  static async open(
    graphStorage: HNSWGraphStorage,
    vectorHeap: VectorHeapFile,
    params: Pick<HNSWParams, 'efSearch' | 'distanceFn'> & { efConstruction?: number },
  ): Promise<HNSWIndex> {
    const { efSearch, efConstruction = graphStorage.M * 2 } = params;
    const index = new HNSWIndex(graphStorage, vectorHeap, graphStorage.M, efConstruction, efSearch);
    await index.loadFromFBF();
    return index;
  }

  // ** PUBLIC INDEX API **

  /**
   * Insert a vector associated with `docId` into the index.
   * Throws if `docId` is already present.
   */
  async insert(docId: number, vector: Float32Array): Promise<void> {
    if (this.docIdIndex.has(docId)) {
      throw new Error(`HNSWIndex: docId ${docId} already exists. Use delete() first to replace it.`);
    }

    // 1. Persist the raw vector — data before index (crash-consistency rule).
    const vectorPtr = await this.vectorHeap.insert(vector);

    // 2. Run Rust graph computation (synchronous, fast).
    this.rustIdx.insert(docId, vector);

    // 3. Fetch the list of nodes whose neighbor lists were modified.
    const dirtyDocIds = this.rustIdx.takeDirtyNodes();

    // 4. Persist the NEW node first (must be in docIdIndex before processing
    //    existing dirty nodes, which may list the new node as a neighbor).
    const newLevel = Math.min(this.rustIdx.getLevel(docId), this.graphStorage.maxStoredLevel);
    const newNeighbors = this.buildNeighborList(docId, newLevel);
    const newNode = new HNSWNode({
      nodeId: 0, // set by insertNode below
      docId,
      level: newLevel,
      vectorPtr,
      neighbors: newNeighbors,
      deleted: false,
    });
    await this.graphStorage.insertNode(newNode); // sets newNode.nodeId
    this.graphStorage.incrementLevel(newLevel);
    this.docIdIndex.set(docId, newNode.nodeId);
    this.vectorPtrCache.set(docId, vectorPtr);

    // 5. Update existing neighbors that had their connection lists modified.
    for (const dirtyDocId of dirtyDocIds) {
      if (dirtyDocId === docId) continue; // already handled above
      const nodeId = this.docIdIndex.get(dirtyDocId);
      if (nodeId === undefined) continue;
      // Zero-allocation: write neighbors directly into the page buffer.
      // Returns void (synchronous) when page is already dirty in-place — no await needed.
      const p = this.graphStorage.updateNodeNeighbors(nodeId, dirtyDocId, this.rustIdx, this.docIdIndex);
      if (p !== undefined) await p;
    }

    // 6. Persist updated graph-level metadata.
    const newEntryDocId = this.rustIdx.getEntryDocId();
    const newEntryNodeId = newEntryDocId !== null ? (this.docIdIndex.get(newEntryDocId) ?? null) : null;
    const newMaxLevel = this.rustIdx.getMaxLevel();
    this.graphStorage.setEntryPoint(newEntryNodeId);
    this.graphStorage.setCurrentMaxLevel(Math.max(newMaxLevel, this.graphStorage.computedMaxLevel()));
    await this.graphStorage.saveMetadata();
  }

  /**
   * Search for the `k` nearest neighbours of `queryVector`.
   * Returns docIds sorted by ascending distance (closest first).
   * Returns an empty array if the index is empty.
   * Pure Rust — no FBF I/O.
   */
  async search(queryVector: Float32Array, k: number): Promise<number[]> {
    if (this.rustIdx.size === 0) return [];
    return this.rustIdx.search(queryVector, k);
  }

  /**
   * Soft-delete the node associated with `docId` from the index.
   * If `docId` is not in the index this is a no-op.
   */
  async delete(docId: number): Promise<void> {
    const nodeId = this.docIdIndex.get(docId);
    if (nodeId === undefined) return;

    // 1. Get the level before deleting from Rust (needed for histogram).
    const level = this.rustIdx.getLevel(docId);

    // 2. Free the vector storage slot.
    const vectorPtr = this.vectorPtrCache.get(docId);
    if (vectorPtr !== undefined) {
      await this.vectorHeap.delete(vectorPtr);
    } else {
      const node = await this.graphStorage.getNode(nodeId);
      await this.vectorHeap.delete(node.vectorPtr);
    }

    // 3. Update histogram before removing from Rust.
    if (level >= 0) this.graphStorage.decrementLevel(level);

    // 4. Run Rust delete (removes back-links from all neighbors).
    this.rustIdx.delete(docId);
    const dirtyDocIds = this.rustIdx.takeDirtyNodes();

    // 5. Hard-delete the node slot from FBF (frees the allocated slot).
    await this.graphStorage.hardDeleteNode(nodeId);
    this.docIdIndex.delete(docId);
    this.vectorPtrCache.delete(docId);

    // 6. Update neighbor lists in FBF for all nodes whose connections changed.
    for (const dirtyDocId of dirtyDocIds) {
      const nbNodeId = this.docIdIndex.get(dirtyDocId);
      if (nbNodeId === undefined) continue;
      const p = this.graphStorage.updateNodeNeighbors(nbNodeId, dirtyDocId, this.rustIdx, this.docIdIndex);
      if (p !== undefined) await p;
    }

    // 7. Update graph-level metadata.
    const newEntryDocId = this.rustIdx.getEntryDocId();
    const newEntryNodeId = newEntryDocId !== null ? (this.docIdIndex.get(newEntryDocId) ?? null) : null;
    const correctMaxLevel = newEntryNodeId !== null ? this.graphStorage.computedMaxLevel() : 0;
    this.graphStorage.setEntryPoint(newEntryNodeId);
    this.graphStorage.setCurrentMaxLevel(correctMaxLevel);
    await this.graphStorage.saveMetadata();
  }

  // ** persistence API for standalone use (not needed when using through DbmsBack) **

  /**
   * Flush all pending changes to disk via the shared FreeBlockFile WAL.
   * Preserves "data before index" write ordering.
   */
  async commit(): Promise<void> {
    await this.vectorHeap.commit(); // data first
    await this.graphStorage.commit(); // index second
  }

  /**
   * Release any open handles held by the storage objects.
   * Always call commit() before close().
   */
  async close(): Promise<void> {
    this.rustIdx.close();
    await this.vectorHeap.close();
    await this.graphStorage.close();
  }

  // ** Private helpers **

  /**
   * Build the `NodeId[][]` neighbor list for `docId` at all layers up to
   * `level`, reading the current neighbor doc_ids from Rust and converting
   * them to FBF NodeIds via `docIdIndex`.
   */
  private buildNeighborList(docId: number, level: number): NodeId[][] {
    // ONE FFI call: [nodeLevel, count0, nb0..., count1, nb1..., ...]
    const allNb = this.rustIdx.getAllNeighbors(docId);
    const neighbors: NodeId[][] = [];
    let pos = 1; // skip nodeLevel header
    for (let layer = 0; layer <= level; layer++) {
      const nbNodeIds: NodeId[] = [];
      if (pos < allNb.length) {
        const count = allNb[pos++];
        for (let i = 0; i < count; i++) {
          const nodeId = this.docIdIndex.get(allNb[pos + i]);
          if (nodeId !== undefined) nbNodeIds.push(nodeId);
        }
        pos += count;
      }
      neighbors.push(nbNodeIds);
    }
    return neighbors;
  }

  /**
   * Bulk-load all persisted nodes from FBF into the Rust index.
   * Two logical passes over the stored nodes:
   *   Pass 1 — import node vectors (runs concurrently with the scan).
   *   Pass 2 — set neighbor connections (converts NodeId → docId).
   * Done in a single physical scan by buffering nodes in memory.
   */
  private async loadFromFBF(): Promise<void> {
    this.docIdIndex.clear();
    this.vectorPtrCache.clear();
    this.graphStorage.resetHistogram();

    const allNodes: HNSWNode[] = [];
    const nodeIdToDocId = new Map<NodeId, number>();

    // Pass 1: import node data into Rust.
    for await (const node of this.graphStorage.scanNodes()) {
      // Skip deleted nodes — their vector slots are freed and their back-links
      // have been removed by softDelete, so they carry no useful graph state.
      if (node.deleted) continue;

      const vector = await this.vectorHeap.get(node.vectorPtr);
      this.rustIdx.importNode(node.docId, node.level, vector, false);
      nodeIdToDocId.set(node.nodeId, node.docId);
      this.docIdIndex.set(node.docId, node.nodeId);
      this.vectorPtrCache.set(node.docId, node.vectorPtr);
      this.graphStorage.incrementLevel(node.level);
      allNodes.push(node);
    }

    // Pass 2: wire neighbor connections.
    for (const node of allNodes) {
      for (let layer = 0; layer <= node.level; layer++) {
        const nbNodeIds = node.neighbors[layer] ?? [];
        const nbDocIds = nbNodeIds.map((nid) => nodeIdToDocId.get(nid)).filter((id): id is number => id !== undefined);
        if (nbDocIds.length > 0) {
          this.rustIdx.importSetNeighbors(node.docId, layer, nbDocIds);
        }
      }
    }

    // Finalise: set entry point (convert stored NodeId → docId).
    const entryNodeId = this.graphStorage.entryPoint;
    const entryDocId = entryNodeId !== null ? (nodeIdToDocId.get(entryNodeId) ?? null) : null;
    this.rustIdx.importFinish(entryDocId, this.graphStorage.currentMaxLevel);
  }
}
