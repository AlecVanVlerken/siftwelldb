// hnsw/hnswInsert.ts

import { HNSWNode, type NodeId } from './hnswNode.mjs';
import { type SearchContext, HNSWSearch, type Candidate } from './hnswSearch.mjs';

export interface InsertContext extends SearchContext {
  /** Persist an updated node (overwrites an existing slot). */
  saveNode(node: HNSWNode): Promise<void>;
}

/**
 * HNSWInsert
 * ----------
 * Implements the HNSW insertion algorithm (Algorithm 1 from the original paper:
 * Malkov & Yashunin, "Efficient and Robust Approximate Nearest-Neighbor Search
 * Using Hierarchical Navigable Small World Graphs", IEEE TPAMI 2020).
 */
export class HNSWInsert {
  /** m_L: level-generation normalisation factor = 1 / ln(M) */
  private readonly mL: number;
  private readonly searcher: HNSWSearch;

  constructor(
    private context: InsertContext,
    private M: number,
    private efConstruction: number,
  ) {
    this.mL = 1.0 / Math.log(M);
    // The internal searcher runs with efConstruction beams.
    this.searcher = new HNSWSearch(context, efConstruction);
  }

  // ── Public entry point ────────────────────────────────────────────────────

  /**
   * Insert `newNode` into the HNSW graph.
   *
   * @param entryPoint  Current graph entry-point (null if graph is empty).
   * @param maxLevel    Current maximum level in the graph.
   * @param newNode     The node to insert.  Its `nodeId` must already be set
   *                    (i.e. the caller has already allocated a slot in graph
   *                    storage and populated `docId`, `vectorPtr`, `level`).
   *                    The method will populate `newNode.neighbors` and call
   *                    `context.saveNode` as needed.
   * @param queryVector The float32 vector for `newNode`.
   * @returns  `{ entryPoint, maxLevel }` — the (possibly updated) graph-level
   *           metadata that must be persisted by the caller.
   */
  async insert(
    entryPoint: NodeId | null,
    maxLevel: number,
    newNode: HNSWNode,
    queryVector: Float32Array,
  ): Promise<{ entryPoint: NodeId; maxLevel: number }> {
    const l = newNode.level; // pre-assigned random level

    // Initialise an empty neighbor list for each layer
    newNode.neighbors = Array.from({ length: l + 1 }, () => []);

    // ── First node: trivially becomes the entry point ──────────────────────
    if (entryPoint === null) {
      await this.context.saveNode(newNode);
      return { entryPoint: newNode.nodeId, maxLevel: l };
    }

    let ep = entryPoint;

    // ── Phase 1: greedy descent from maxLevel down to l+1 ─────────────────
    for (let layer = maxLevel; layer >= l + 1; layer--) {
      ep = await this.searcher.greedySearchLayer(ep, queryVector, layer);
    }

    // ── Phase 2: beam search + neighbour selection for layers l … 0 ───────
    for (let layer = Math.min(l, maxLevel); layer >= 0; layer--) {
      const Mmax = layer === 0 ? this.M * 2 : this.M;
      const ef = this.efConstruction;

      const candidates: Candidate[] = await this.searcher.searchLayer(ep, queryVector, ef, layer);
      const newNeighbors = this.selectNeighbors(candidates, Mmax);

      // Assign neighbours to the new node
      newNode.neighbors[layer] = newNeighbors.map((c) => c.nodeId);

      // Update existing neighbours: add a back-link to newNode, then prune
      for (const c of newNeighbors) {
        const neighbor = await this.context.getNode(c.nodeId);
        const layerNeighbors = neighbor.neighbors[layer] ?? [];

        // Add back-link
        layerNeighbors.push(newNode.nodeId);
        neighbor.neighbors[layer] = layerNeighbors;

        // Prune if over limit
        if (layerNeighbors.length > Mmax) {
          neighbor.neighbors[layer] = await this.pruneNeighbors(c.nodeId, layerNeighbors, Mmax, queryVector);
        }

        await this.context.saveNode(neighbor);
      }

      // Advance entry point for the next (lower) layer
      if (candidates.length > 0) {
        const sorted = [...candidates].sort((a: Candidate, b: Candidate) => a.distance - b.distance);
        ep = sorted[0].nodeId;
      }
    }

    // ── Save the new node ──────────────────────────────────────────────────
    await this.context.saveNode(newNode);

    // ── Update entry point if we reached a new max level ──────────────────
    const newEntryPoint = l > maxLevel ? newNode.nodeId : entryPoint;
    const newMaxLevel = Math.max(maxLevel, l);
    return { entryPoint: newEntryPoint, maxLevel: newMaxLevel };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Select the `M` nearest candidates from a list.
   * This is the "simple" variant; a heuristic variant could also be used.
   */
  private selectNeighbors(candidates: Candidate[], M: number): Candidate[] {
    return [...candidates].sort((a, b) => a.distance - b.distance).slice(0, M);
  }

  /**
   * Prune the neighbor list of an existing node back to `M` connections.
   * Called after adding a back-link that caused the list to exceed `Mmax`.
   */
  private async pruneNeighbors(
    nodeId: NodeId,
    neighbors: NodeId[],
    Mmax: number,
    _queryVector: Float32Array,
  ): Promise<NodeId[]> {
    const nodeVec = await this.context.getVector(nodeId);
    const scored: { nodeId: NodeId; distance: number }[] = [];
    for (const nid of neighbors) {
      try {
        const neighbor = await this.context.getNode(nid);
        if (neighbor.deleted) continue; // skip soft-deleted nodes
        const vec = await this.context.getVector(nid);
        scored.push({ nodeId: nid, distance: this.context.computeDistance(nodeVec, vec) });
      } catch {
        // skip any invalid / hard-deleted references
      }
    }
    return this.selectNeighbors(scored, Mmax).map((c) => c.nodeId);
  }

  /**
   * Generate a random level for a new node using the same probabilistic model
   * as the original HNSW paper: l = floor(-ln(U(0,1)) × m_L).
   *
   * @param maxStoredLevel  Upper cap on the level (from graph storage config).
   */
  randomLevel(maxStoredLevel: number): number {
    const l = Math.floor(-Math.log(Math.random()) * this.mL);
    return Math.min(l, maxStoredLevel);
  }
}
