// hnsw/hnswSearch.ts

import { type NodeId, HNSWNode } from './hnswNode.mjs';

export interface SearchContext {
  /** Load a node by its persistent id. */
  getNode(nodeId: NodeId): Promise<HNSWNode>;
  /** Load the float32 vector associated with a node. */
  getVector(nodeId: NodeId): Promise<Float32Array>;
  /** Synchronous distance between two vectors (e.g. squared-euclidean). */
  computeDistance(a: Float32Array, b: Float32Array): number;
}

// ─── Internal priority-queue helpers ─────────────────────────────────────────
// We use simple sorted arrays here.  For large ef values a binary heap would
// be faster, but sorted arrays are straightforward to reason about.

export type Candidate = { nodeId: NodeId; distance: number };

function candidateMinFirst(a: Candidate, b: Candidate): number {
  return a.distance - b.distance;
}

// Maintain a sorted (ascending) array and pop/peek the min in O(1).
class CandidateList {
  private items: Candidate[] = [];

  push(c: Candidate): void {
    const idx = this.items.findIndex((x) => x.distance > c.distance);
    if (idx === -1) {
      this.items.push(c);
    } else {
      this.items.splice(idx, 0, c);
    }
  }

  /** Pop the closest (min-distance) candidate. */
  popMin(): Candidate {
    return this.items.shift()!;
  }

  /** Return the closest (min-distance) without removing it. */
  peekMin(): Candidate {
    return this.items[0];
  }

  /** Return the furthest (max-distance) without removing it. */
  peekMax(): Candidate {
    return this.items[this.items.length - 1];
  }

  /** Remove the furthest candidate. */
  removeMax(): Candidate {
    return this.items.pop()!;
  }

  size(): number {
    return this.items.length;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  toArray(): Candidate[] {
    return [...this.items];
  }
}

// ─── HNSWSearch ──────────────────────────────────────────────────────────────

export class HNSWSearch {
  constructor(
    private context: SearchContext,
    private efSearch: number,
  ) {}

  /**
   * Search for the `k` nearest neighbors of `queryVector`.
   *
   * @param entryPoint  The current entry-point of the HNSW graph.
   * @param maxLevel    The highest level present in the graph.
   * @param queryVector The query to answer.
   * @param k           Number of nearest neighbors to return.
   * @returns Sorted array of NodeIds (closest first).
   */
  async search(entryPoint: NodeId, maxLevel: number, queryVector: Float32Array, k: number): Promise<NodeId[]> {
    let ep = entryPoint;

    // Phase 1: greedy descent from maxLevel down to layer 1
    for (let level = maxLevel; level >= 1; level--) {
      ep = await this.greedySearchLayer(ep, queryVector, level);
    }

    // Phase 2: beam search at layer 0 with ef candidates
    const ef = Math.max(k, this.efSearch);
    const results = await this.searchLayer(ep, queryVector, ef, 0);

    // Return the top-k nodeIds (already sorted closest-first)
    return results
      .sort(candidateMinFirst)
      .slice(0, k)
      .map((c) => c.nodeId);
  }

  /**
   * Greedy single-path descent on `level`: starting from `entry`, follow the
   * edge that most reduces the distance to `queryVector` until no improvement.
   * Returns the NodeId of the closest found node at that level.
   */
  async greedySearchLayer(entry: NodeId, queryVector: Float32Array, level: number): Promise<NodeId> {
    let currentId = entry;
    let currentVec = await this.context.getVector(currentId);
    let currentDist = this.context.computeDistance(queryVector, currentVec);

    while (true) {
      const currentNode = await this.context.getNode(currentId);
      const neighbors = currentNode.neighbors[level] ?? [];
      let improved = false;

      for (const neighborId of neighbors) {
        const neighborNode = await this.context.getNode(neighborId);
        if (neighborNode.deleted) continue;
        const neighborVec = await this.context.getVector(neighborId);
        const d = this.context.computeDistance(queryVector, neighborVec);
        if (d < currentDist) {
          currentDist = d;
          currentId = neighborId;
          currentVec = neighborVec;
          improved = true;
        }
      }

      if (!improved) break;
    }

    return currentId;
  }

  /**
   * Beam search on `level` starting from `entry`, collecting up to `ef`
   * nearest candidates to `queryVector`.
   *
   * Implements Algorithm 2 ("SEARCH-LAYER") from the HNSW paper.
   */
  async searchLayer(entry: NodeId, queryVector: Float32Array, ef: number, level: number): Promise<Candidate[]> {
    const entryVec = await this.context.getVector(entry);
    const entryDist = this.context.computeDistance(queryVector, entryVec);

    const visited = new Set<bigint>([entry]);
    const candidates = new CandidateList(); // min-heap by distance
    const dynamic = new CandidateList(); // working set, kept ≤ ef; max-heap for removal

    candidates.push({ nodeId: entry, distance: entryDist });
    dynamic.push({ nodeId: entry, distance: entryDist });

    while (!candidates.isEmpty()) {
      const c = candidates.popMin();
      const f = dynamic.peekMax();

      // Termination: if the closest unexplored candidate is farther than
      // the furthest found so far, we cannot improve.
      if (c.distance > f.distance) break;

      const cNode = await this.context.getNode(c.nodeId);
      const neighbors = cNode.neighbors[level] ?? [];

      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const neighborNode = await this.context.getNode(neighborId);
        if (neighborNode.deleted) continue;

        const neighborVec = await this.context.getVector(neighborId);
        const d = this.context.computeDistance(queryVector, neighborVec);
        const fDist = dynamic.peekMax().distance;

        if (d < fDist || dynamic.size() < ef) {
          candidates.push({ nodeId: neighborId, distance: d });
          dynamic.push({ nodeId: neighborId, distance: d });
          if (dynamic.size() > ef) {
            dynamic.removeMax();
          }
        }
      }
    }

    return dynamic.toArray();
  }
}
