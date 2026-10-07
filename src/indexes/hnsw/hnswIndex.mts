//@author: Thomas Dumon with usage of Claude sonnet 4.6
//@date: 2026-02-18

import { VectorHeapFile, type VectorPointer } from './vectorHeapFile.mjs';
import { HNSWNode, type NodeId } from './hnswNode.mjs';
import { decodeNodeId, HNSWGraphStorage } from './hnswGraphStorage.mjs';
import { HnswIndexNative } from './hnswNative.mjs';

export type DistanceFn = (a: Float32Array, b: Float32Array) => number;

export type HNSWParams = {
  M: number;
  efConstruction: number;
  efSearch: number;
  distanceFn?: DistanceFn;
};

export type HnswUnitLocation = {
  kind: 'hnsw-graph' | 'hnsw-vector';
  nodeId: NodeId;
  blockNumber: number;
  hnswUnitState: 'live' | 'tombstoned-retained';
};

export type HnswGraphStructureNode = {
  nodeId: NodeId;
  docId: number;
  level: number;
  vectorPageId: number;
  vectorSlotId: number;
  vector: number[];
  deleted: boolean;
  neighbors: NodeId[][];
};

export type HnswGraphStructureSnapshot = {
  entryPoint: NodeId | null;
  currentMaxLevel: number;
  nodes: HnswGraphStructureNode[];
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
  private rustIdx: HnswIndexNative;

  private readonly M: number;
  private readonly efConstruction: number;
  private readonly efSearch: number;

  /**
   * In-memory reverse index for live nodes: docId -> NodeId.
   * Rebuilt from disk on open() by scanning graph storage.
   * Updated incrementally by insert(), delete(), and relocation helpers.
   */
  private readonly docIdIndex = new Map<number, NodeId>();

  /**
   * In-memory reverse index for tombstoned nodes: docId -> NodeId.
   * Tombstoned nodes stay physically present and may remain routing artifacts,
   * but they must never be returned as user-visible search results.
   */
  private readonly tombstonedDocIdIndex = new Map<number, NodeId>();

  /**
   * Reverse index for every physical HNSW node, live or tombstoned.
   * Persisted neighbor lists need to round-trip references to tombstoned
   * routing nodes even though docIdIndex is the live-result filter.
   */
  private readonly nodeIdByDocId = new Map<number, NodeId>();

  /** Cache of live docId -> VectorPointer for relocation and maintenance helpers. */
  private readonly vectorPtrCache = new Map<number, VectorPointer>();

  // Private constructor — use the static factory methods.
  private constructor(
    private readonly graphStorage: HNSWGraphStorage,
    private readonly vectorHeap: VectorHeapFile,
    M: number,
    efConstruction: number,
    efSearch: number,
  ) {
    this.M = M;
    this.efConstruction = efConstruction;
    this.efSearch = efSearch;
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
  async insert(docId: number, vector: Float32Array, options: { maxBlockExclusive?: number } = {}): Promise<void> {
    if (this.nodeIdByDocId.has(docId)) {
      const state = this.tombstonedDocIdIndex.has(docId) ? 'tombstoned' : 'live';
      throw new Error(
        `HNSWIndex: docId ${docId} already exists as a ${state} node. Maintenance cleanup must remove it before reuse.`,
      );
    }

    // 1. Persist the raw vector — data before index (crash-consistency rule).
    const vectorPtr = await this.vectorHeap.insert(vector, options);

    // 2. Run Rust graph computation (synchronous, fast).
    this.rustIdx.insert(docId, vector);

    // 3. Fetch the list of nodes whose neighbor lists were modified.
    const dirtyDocIds = this.rustIdx.takeDirtyNodes();

    // 4. Persist the NEW node first (must be in nodeIdByDocId before processing
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
    await this.graphStorage.insertNode(newNode, options); // sets newNode.nodeId
    this.graphStorage.incrementLevel(newLevel);
    this.nodeIdByDocId.set(docId, newNode.nodeId);
    this.docIdIndex.set(docId, newNode.nodeId);
    this.vectorPtrCache.set(docId, vectorPtr);

    // 5. Update existing neighbors that had their connection lists modified.
    for (const dirtyDocId of dirtyDocIds) {
      if (dirtyDocId === docId) continue; // already handled above
      const nodeId = this.nodeIdByDocId.get(dirtyDocId);
      if (nodeId === undefined) continue;
      // Zero-allocation: write neighbors directly into the page buffer.
      // Returns void (synchronous) when page is already dirty in-place — no await needed.
      const p = this.graphStorage.updateNodeNeighbors(nodeId, dirtyDocId, this.rustIdx, this.nodeIdByDocId);
      if (p !== undefined) await p;
    }

    // 6. Persist updated graph-level metadata.
    const newEntryDocId = this.rustIdx.getEntryDocId();
    const newEntryNodeId = newEntryDocId !== null ? (this.nodeIdByDocId.get(newEntryDocId) ?? null) : null;
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
    if (k <= 0 || this.docIdIndex.size === 0) return [];

    const target = Math.min(k, this.docIdIndex.size);
    const knownPhysicalNodes = this.docIdIndex.size + this.tombstonedDocIdIndex.size;
    const initialFetch = Math.min(knownPhysicalNodes, Math.max(k, target + this.tombstonedDocIdIndex.size));
    let results = this.filterLiveResults(this.rustIdx.search(queryVector, initialFetch), target);

    // Native search also filters deleted nodes, but wrapper-level filtering is
    // the durable invariant. Overfetch once so tombstones do not reduce k live
    // results when enough live candidates exist.
    if (results.length < target && initialFetch < knownPhysicalNodes) {
      results = this.filterLiveResults(this.rustIdx.search(queryVector, knownPhysicalNodes), target);
    }

    // If tombstones disconnect native approximate traversal enough to under-yield,
    // preserve the user-visible invariant by filling from the persisted live
    // vector set. This only runs on the tombstone path; ordinary live-only HNSW
    // search keeps its native result behavior.
    if (results.length < target && this.tombstonedDocIdIndex.size > 0) {
      results = await this.exactLiveSearch(queryVector, target);
    }

    return results;
  }

  /**
   * Persistently mark a document's HNSW node as tombstoned without reclaiming
   * graph or vector storage.
   *
   * Normal DBMS deletion calls this through delete(). Vector and graph-node
   * storage remain allocated until a later maintenance/vacuum phase.
   */
  async tombstone(docId: number): Promise<boolean> {
    const nodeId = this.docIdIndex.get(docId);
    if (nodeId === undefined) return false;

    const node = await this.getLiveNodeForDocument(docId, nodeId);
    if (node === undefined) return false;

    node.deleted = true;
    await this.graphStorage.saveNode(node);

    this.docIdIndex.delete(docId);
    this.tombstonedDocIdIndex.set(docId, node.nodeId);
    this.nodeIdByDocId.set(docId, node.nodeId);
    this.vectorPtrCache.delete(docId);

    // Native delete is also a tombstone: it keeps the graph node allocated for
    // traversal but removes it from native live-result bookkeeping.
    this.rustIdx.delete(docId);

    this.graphStorage.setCurrentMaxLevel(this.graphStorage.computedMaxLevel());
    await this.graphStorage.saveMetadata();
    return true;
  }

  /**
   * Return whether a document id is currently present in this HNSW index.
   *
   * DbmsBack uses this during RecordStore relocation to preserve existing HNSW
   * membership without accidentally indexing documents that were not indexed
   * before relocation.
   */
  hasDocument(docId: number): boolean {
    return this.docIdIndex.has(docId);
  }

  /**
   * Rename the physical document pointer associated with an existing HNSW node.
   *
   * RecordStore relocation changes the document's physical record pointer, but
   * must not delete and reinsert the HNSW entry because that can perturb graph
   * topology and semantic result ordering. This updates the persisted doc id in
   * place, then reloads the native index from the unchanged persisted graph.
   */
  async relabelDocument(oldDocId: number, newDocId: number): Promise<boolean> {
    if (oldDocId === newDocId) return this.docIdIndex.has(oldDocId);

    const nodeId = this.docIdIndex.get(oldDocId);
    if (nodeId === undefined) return false;
    if (this.nodeIdByDocId.has(newDocId)) {
      throw new Error(`HNSWIndex: docId ${newDocId} already exists.`);
    }

    const node = await this.getLiveNodeForDocument(oldDocId, nodeId);
    if (node === undefined) return false;

    node.docId = newDocId;
    await this.graphStorage.saveNode(node);
    this.nodeIdByDocId.delete(oldDocId);
    this.nodeIdByDocId.set(newDocId, node.nodeId);
    this.docIdIndex.delete(oldDocId);
    this.docIdIndex.set(newDocId, node.nodeId);
    this.vectorPtrCache.delete(oldDocId);
    this.vectorPtrCache.set(newDocId, node.vectorPtr);
    await this.pruneNodesWithMissingVectors();
    await this.reloadNativeFromFBF();
    return true;
  }

  getNodeIdForDocument(docId: number): NodeId | undefined {
    return this.docIdIndex.get(docId);
  }

  async inspectGraphStructure(): Promise<HnswGraphStructureNode[]> {
    return (await this.inspectGraphStructureSnapshot()).nodes;
  }

  async inspectGraphStructureSnapshot(): Promise<HnswGraphStructureSnapshot> {
    const nodes: HnswGraphStructureNode[] = [];
    for await (const node of this.graphStorage.scanNodes()) {
      const vector = await this.vectorHeap.get(node.vectorPtr);
      nodes.push({
        nodeId: node.nodeId,
        docId: node.docId,
        level: node.level,
        vectorPageId: node.vectorPtr.pageId,
        vectorSlotId: node.vectorPtr.slotId,
        vector: Array.from(vector),
        deleted: node.deleted,
        neighbors: node.neighbors.map((layer) => [...layer].sort((a, b) => a - b)),
      });
    }
    return {
      entryPoint: this.graphStorage.entryPoint,
      currentMaxLevel: this.graphStorage.currentMaxLevel,
      nodes: nodes.sort((a, b) => a.nodeId - b.nodeId),
    };
  }

  async listRelocationTargets(): Promise<HnswUnitLocation[]> {
    const targets: HnswUnitLocation[] = [];

    for await (const node of this.graphStorage.scanNodes()) {
      // Tombstoned nodes are semantically deleted, but they are still retained
      // physical HNSW units. Incremental compaction may relocate them when
      // they block the tail; full vacuum is responsible for eventually
      // removing them.
      const hnswUnitState = node.deleted ? 'tombstoned-retained' : 'live';
      targets.push({
        kind: 'hnsw-graph',
        nodeId: node.nodeId,
        blockNumber: decodeNodeId(node.nodeId).pageId,
        hnswUnitState,
      });
      targets.push({
        kind: 'hnsw-vector',
        nodeId: node.nodeId,
        blockNumber: node.vectorPtr.pageId,
        hnswUnitState,
      });
    }

    return targets;
  }

  async relocateGraphNode(nodeId: NodeId, options: { maxBlockExclusive?: number } = {}): Promise<NodeId> {
    const result = await this.graphStorage.relocateNode(nodeId, options);
    await this.pruneNodesWithMissingVectors();
    await this.reloadNativeFromFBF();
    return result.newNodeId;
  }

  async relocateVectorForNode(nodeId: NodeId, options: { maxBlockExclusive?: number } = {}): Promise<VectorPointer> {
    const node = await this.graphStorage.getNode(nodeId);
    const newPtr = await this.vectorHeap.relocate(node.vectorPtr, options);
    node.vectorPtr = newPtr;
    await this.graphStorage.saveNode(node);
    if (node.deleted) {
      this.vectorPtrCache.delete(node.docId);
      this.tombstonedDocIdIndex.set(node.docId, node.nodeId);
    } else {
      this.vectorPtrCache.set(node.docId, newPtr);
    }
    await this.pruneNodesWithMissingVectors();
    await this.reloadNativeFromFBF();
    return newPtr;
  }

  async relocateMetadata(options: { maxBlockExclusive?: number } = {}): Promise<number | null> {
    return await this.graphStorage.relocateMetadata(options);
  }

  /**
   * Release all graph, vector, and metadata blocks owned by this collection-local
   * HNSW index. Used when a whole collection is dropped.
   */
  async dropStorage(): Promise<void> {
    const nodes: HNSWNode[] = [];

    if (this.graphStorage.entryPoint !== null) {
      for await (const node of this.graphStorage.scanNodes()) {
        nodes.push(node);
      }
    }

    for (const node of nodes) {
      await this.vectorHeap.delete(node.vectorPtr);
    }

    for (const node of nodes) {
      await this.graphStorage.hardDeleteNode(node.nodeId);
    }

    this.nodeIdByDocId.clear();
    this.docIdIndex.clear();
    this.tombstonedDocIdIndex.clear();
    this.vectorPtrCache.clear();
    this.graphStorage.resetHistogram();
    this.graphStorage.setEntryPoint(null);
    this.graphStorage.setCurrentMaxLevel(0);
    await this.graphStorage.freeMetadataBlock();

    this.rustIdx.close();
    this.rustIdx = new HnswIndexNative(this.vectorHeap.dimension, this.M, this.efConstruction, this.efSearch);
  }

  /**
   * Cheap logical delete for the normal user-facing path.
   *
   * The persisted graph node and vector are retained as tombstoned semantic
   * storage. This preserves any routing value the node still has and avoids the
   * old collection-local rebuild during foreground document deletion.
   *
   * Returns true only when a live semantic entry was found and tombstoned.
   */
  async delete(docId: number): Promise<boolean> {
    return await this.tombstone(docId);
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
   * them to FBF NodeIds via the persisted docId → NodeId map.
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
          const nodeId = this.nodeIdByDocId.get(allNb[pos + i]);
          if (nodeId !== undefined) nbNodeIds.push(nodeId);
        }
        pos += count;
      }
      neighbors.push(nbNodeIds);
    }
    return neighbors;
  }

  private async reloadNativeFromFBF(): Promise<void> {
    this.rustIdx.close();
    this.rustIdx = new HnswIndexNative(this.vectorHeap.dimension, this.M, this.efConstruction, this.efSearch);
    await this.loadFromFBF();
  }

  private filterLiveResults(docIds: number[], target: number): number[] {
    const filtered: number[] = [];
    for (const docId of docIds) {
      if (!this.docIdIndex.has(docId)) continue;
      filtered.push(docId);
      if (filtered.length >= target) break;
    }
    return filtered;
  }

  private async exactLiveSearch(queryVector: Float32Array, target: number): Promise<number[]> {
    const scored: Array<{ docId: number; distance: number }> = [];

    for (const [docId, nodeId] of [...this.docIdIndex]) {
      const node = await this.getLiveNodeForDocument(docId, nodeId);
      if (node === undefined) continue;
      const vector = await this.vectorHeap.get(node.vectorPtr);
      scored.push({ docId, distance: this.squaredDistance(queryVector, vector) });
    }

    return scored
      .sort((a, b) => {
        const distanceDiff = a.distance - b.distance;
        return distanceDiff !== 0 ? distanceDiff : a.docId - b.docId;
      })
      .slice(0, target)
      .map((entry) => entry.docId);
  }

  private squaredDistance(a: Float32Array, b: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      const diff = a[i] - b[i];
      sum += diff * diff;
    }
    return sum;
  }

  /**
   * Maintenance-only live rebuild helper retained for future vacuum/cleanup
   * work. Normal user-facing deletes must call delete()/tombstone() instead.
   */
  private async rebuildWithoutDocumentForMaintenance(docIdToRemove: number): Promise<void> {
    const retained: Array<{ docId: number; vector: Float32Array; level: number; neighborDocIds: number[][] }> = [];
    const existingNodes: HNSWNode[] = [];
    const liveVectors = new Map<number, Float32Array>();

    for await (const node of this.graphStorage.scanNodes()) {
      existingNodes.push(node);
      if (node.deleted || node.docId === docIdToRemove) continue;
      liveVectors.set(node.docId, await this.vectorHeap.get(node.vectorPtr));
    }

    if (!existingNodes.some((node) => !node.deleted && node.docId === docIdToRemove)) {
      return;
    }

    this.rustIdx.delete(docIdToRemove);
    this.rustIdx.takeDirtyNodes();
    const entryDocId = this.rustIdx.getEntryDocId();

    for (const [docId, vector] of [...liveVectors.entries()].sort((a, b) => a[0] - b[0])) {
      const level = Math.min(this.rustIdx.getLevel(docId), this.graphStorage.maxStoredLevel);
      if (level < 0) continue;
      retained.push({
        docId,
        vector,
        level,
        neighborDocIds: this.getNativeNeighborDocIds(docId, level, docIdToRemove),
      });
    }

    for (const node of existingNodes) {
      await this.vectorHeap.delete(node.vectorPtr);
    }

    for (const node of existingNodes) {
      await this.graphStorage.hardDeleteNode(node.nodeId);
    }

    this.nodeIdByDocId.clear();
    this.docIdIndex.clear();
    this.tombstonedDocIdIndex.clear();
    this.vectorPtrCache.clear();
    this.graphStorage.resetHistogram();
    this.graphStorage.setEntryPoint(null);
    this.graphStorage.setCurrentMaxLevel(0);
    await this.graphStorage.saveMetadata();
    this.rustIdx.close();
    this.rustIdx = new HnswIndexNative(this.vectorHeap.dimension, this.M, this.efConstruction, this.efSearch);

    const docIdToNodeId = new Map<number, NodeId>();
    for (const entry of retained) {
      const vectorPtr = await this.vectorHeap.insert(entry.vector);
      const node = new HNSWNode({
        nodeId: 0,
        docId: entry.docId,
        level: entry.level,
        vectorPtr,
        neighbors: Array.from({ length: entry.level + 1 }, () => []),
        deleted: false,
      });
      await this.graphStorage.insertNode(node);
      this.graphStorage.incrementLevel(entry.level);
      docIdToNodeId.set(entry.docId, node.nodeId);
      this.nodeIdByDocId.set(entry.docId, node.nodeId);
      this.docIdIndex.set(entry.docId, node.nodeId);
      this.vectorPtrCache.set(entry.docId, vectorPtr);
    }

    const nodeByDocId = new Map<number, HNSWNode>();
    for (const entry of retained) {
      const nodeId = docIdToNodeId.get(entry.docId);
      if (nodeId === undefined) continue;
      const node = await this.graphStorage.getNode(nodeId);
      node.neighbors = entry.neighborDocIds.map((layer) =>
        layer.map((neighborDocId) => docIdToNodeId.get(neighborDocId)).filter((id): id is NodeId => id !== undefined),
      );
      nodeByDocId.set(entry.docId, node);
    }

    for (let i = 1; i < retained.length; i++) {
      const previous = nodeByDocId.get(retained[i - 1].docId);
      const current = nodeByDocId.get(retained[i].docId);
      if (previous === undefined || current === undefined) continue;
      this.prependLayerZeroNeighbor(previous, current.nodeId);
      this.prependLayerZeroNeighbor(current, previous.nodeId);
    }

    for (const node of nodeByDocId.values()) {
      await this.graphStorage.saveNode(node);
    }

    const newEntryPoint = entryDocId !== null ? (docIdToNodeId.get(entryDocId) ?? null) : null;
    this.graphStorage.setEntryPoint(newEntryPoint);
    this.graphStorage.setCurrentMaxLevel(newEntryPoint === null ? 0 : this.graphStorage.computedMaxLevel());
    await this.graphStorage.saveMetadata();
    await this.reloadNativeFromFBF();
  }

  private prependLayerZeroNeighbor(node: HNSWNode, neighbor: NodeId): void {
    const current = node.neighbors[0] ?? [];
    if (current.includes(neighbor)) return;
    node.neighbors[0] = [neighbor, ...current].slice(0, this.M * 2);
  }

  private getNativeNeighborDocIds(docId: number, level: number, removedDocId: number): number[][] {
    const allNb = this.rustIdx.getAllNeighbors(docId);
    const neighbors: number[][] = [];
    let pos = 1;
    for (let layer = 0; layer <= level; layer++) {
      const layerNeighbors: number[] = [];
      if (pos < allNb.length) {
        const count = allNb[pos++];
        for (let i = 0; i < count; i++) {
          const neighborDocId = allNb[pos + i];
          if (neighborDocId !== removedDocId && this.nodeIdByDocId.has(neighborDocId)) {
            layerNeighbors.push(neighborDocId);
          }
        }
        pos += count;
      }
      neighbors.push(layerNeighbors);
    }
    return neighbors;
  }

  private async getLiveNodeForDocument(docId: number, cachedNodeId: NodeId): Promise<HNSWNode | undefined> {
    try {
      const cached = await this.graphStorage.getNode(cachedNodeId);
      if (!cached.deleted && cached.docId === docId) {
        this.nodeIdByDocId.set(docId, cached.nodeId);
        this.tombstonedDocIdIndex.delete(docId);
        this.docIdIndex.set(docId, cached.nodeId);
        this.vectorPtrCache.set(docId, cached.vectorPtr);
        return cached;
      }
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('slot is not occupied')) {
        throw error;
      }
    }

    for await (const node of this.graphStorage.scanNodes()) {
      if (node.docId === docId) {
        this.nodeIdByDocId.set(docId, node.nodeId);
        if (node.deleted) {
          this.docIdIndex.delete(docId);
          this.tombstonedDocIdIndex.set(docId, node.nodeId);
          return undefined;
        }
        this.tombstonedDocIdIndex.delete(docId);
        this.docIdIndex.set(docId, node.nodeId);
        this.vectorPtrCache.set(docId, node.vectorPtr);
        return node;
      }
    }

    this.docIdIndex.delete(docId);
    this.tombstonedDocIdIndex.delete(docId);
    this.nodeIdByDocId.delete(docId);
    return undefined;
  }

  private async pruneNodesWithMissingVectors(): Promise<void> {
    const invalidNodeIds: NodeId[] = [];

    for await (const node of this.graphStorage.scanNodes()) {
      if (node.deleted) continue;
      try {
        await this.vectorHeap.get(node.vectorPtr);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('is not occupied')) {
          throw error;
        }
        invalidNodeIds.push(node.nodeId);
      }
    }

    if (invalidNodeIds.length === 0) return;

    const invalid = new Set(invalidNodeIds);
    for await (const node of this.graphStorage.scanNodes()) {
      if (invalid.has(node.nodeId)) continue;
      let changed = false;
      node.neighbors = node.neighbors.map((layer) => {
        const filtered = layer.filter((neighbor) => !invalid.has(neighbor));
        if (filtered.length !== layer.length) changed = true;
        return filtered;
      });
      if (changed) await this.graphStorage.saveNode(node);
    }

    if (this.graphStorage.entryPoint !== null && invalid.has(this.graphStorage.entryPoint)) {
      this.graphStorage.setEntryPoint(null);
    }

    for (const nodeId of invalidNodeIds) {
      const node = await this.graphStorage.getNode(nodeId).catch(() => null);
      if (node !== null) {
        this.nodeIdByDocId.delete(node.docId);
        this.docIdIndex.delete(node.docId);
        this.tombstonedDocIdIndex.delete(node.docId);
        this.vectorPtrCache.delete(node.docId);
      }
      await this.graphStorage.hardDeleteNode(nodeId);
    }

    this.graphStorage.setCurrentMaxLevel(this.graphStorage.computedMaxLevel());
    await this.graphStorage.saveMetadata();
  }

  /**
   * Bulk-load all persisted nodes from FBF into the Rust index.
   * Two logical passes over the stored nodes:
   *   Pass 1 — import node vectors (runs concurrently with the scan).
   *   Pass 2 — set neighbor connections (converts NodeId → docId).
   * Done in a single physical scan by buffering nodes in memory.
   */
  private async loadFromFBF(): Promise<void> {
    this.nodeIdByDocId.clear();
    this.docIdIndex.clear();
    this.tombstonedDocIdIndex.clear();
    this.vectorPtrCache.clear();
    this.graphStorage.resetHistogram();

    const allNodes: HNSWNode[] = [];
    const nodeIdToDocId = new Map<NodeId, number>();

    // Pass 1: import every physical node into Rust. Tombstoned nodes are
    // retained as routing artifacts, while docIdIndex remains the live filter.
    for await (const node of this.graphStorage.scanNodes()) {
      const vector = await this.vectorHeap.get(node.vectorPtr);
      this.rustIdx.importNode(node.docId, node.level, vector, node.deleted);
      nodeIdToDocId.set(node.nodeId, node.docId);
      this.nodeIdByDocId.set(node.docId, node.nodeId);
      if (node.deleted) {
        this.tombstonedDocIdIndex.set(node.docId, node.nodeId);
      } else {
        this.docIdIndex.set(node.docId, node.nodeId);
        this.vectorPtrCache.set(node.docId, node.vectorPtr);
      }
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
    const storedEntryDocId = entryNodeId !== null ? (nodeIdToDocId.get(entryNodeId) ?? null) : null;
    const entryDocId =
      storedEntryDocId !== null && this.docIdIndex.has(storedEntryDocId)
        ? storedEntryDocId
        : (this.docIdIndex.keys().next().value ?? null);
    this.rustIdx.importFinish(entryDocId, this.graphStorage.currentMaxLevel);
  }
}
