//@author: Thomas Dumon with usage of Claude sonnet 4.6
//@date: 2026-02-18

import { HNSWNode, type NodeId } from './hnswNode.mjs';

export interface DeleteContext {
  /** Load a node by id. */
  getNode(nodeId: NodeId): Promise<HNSWNode>;
  /** Persist a modified node. */
  saveNode(node: HNSWNode): Promise<void>;
  /**
   * Physically free the slot occupied by this node.
   * Only safe to call after all neighbour references have been removed.
   */
  hardDeleteNode(nodeId: NodeId): Promise<void>;
}

/**
 * HNSWDelete
 * ----------
 * Handles node removal from the HNSW graph.
 *
 * Two strategies are provided:
 *
 * 1. **Soft delete** (`softDelete`): marks the node's `deleted` flag and
 *    removes back-links from all current neighbours.  The slot is kept
 *    allocated, so existing `NodeId` references remain valid.  Deleted nodes
 *    are skipped transparently during search.  This is the recommended
 *    approach because it is O(M × maxLevel) and never invalidates the graph
 *    structure.
 *
 * 2. **Hard delete** (`hardDelete`): performs a soft delete first, then
 *    additionally frees the storage slot.  Use only when you are certain that
 *    no other node still holds a reference to the deleted NodeId (e.g. after
 *    a full graph compaction pass).
 */
export class HNSWDelete {
  constructor(private context: DeleteContext) {}

  /**
   * Mark `targetNodeId` as deleted and remove its id from every neighbour's
   * connection list.
   *
   * @param targetNodeId  The node to delete.
   * @param entryPoint    The current graph entry point.
   * @param maxLevel      The current maximum graph level.
   * @returns  Updated `{ entryPoint, maxLevel }` (the entry point may change
   *           if the deleted node was the entry point).
   */
  async softDelete(
    targetNodeId: NodeId,
    entryPoint: NodeId | null,
    maxLevel: number,
  ): Promise<{ entryPoint: NodeId | null; maxLevel: number }> {
    const target = await this.context.getNode(targetNodeId);
    target.deleted = true;

    // Remove back-links: for every layer the node participates in, tell each
    // neighbour to drop the reference to this node.
    for (let layer = 0; layer <= target.level; layer++) {
      const neighbors = target.neighbors[layer] ?? [];
      for (const neighborId of neighbors) {
        let neighbor: HNSWNode;
        try {
          neighbor = await this.context.getNode(neighborId);
        } catch {
          continue; // neighbour was already deleted / invalid
        }
        const layerNeighbors = neighbor.neighbors[layer] ?? [];
        neighbor.neighbors[layer] = layerNeighbors.filter((id) => id !== targetNodeId);
        await this.context.saveNode(neighbor);
      }
    }

    // If the deleted node was the entry point, pick a replacement BEFORE
    // clearing the neighbour lists (pickNewEntryPoint reads them).
    let newEpResult: { entryPoint: NodeId | null; maxLevel: number };
    if (entryPoint === targetNodeId) {
      newEpResult = await this.pickNewEntryPoint(target, maxLevel);
    } else {
      newEpResult = { entryPoint, maxLevel };
    }

    // Clear the target's own neighbour lists to free memory in the serialised slot.
    target.neighbors = target.neighbors.map(() => []);
    await this.context.saveNode(target);

    return newEpResult;
  }

  /**
   * Perform a soft delete and then free the storage slot.
   * Only safe when you are sure no remaining node references `targetNodeId`.
   */
  async hardDelete(
    targetNodeId: NodeId,
    entryPoint: NodeId | null,
    maxLevel: number,
  ): Promise<{ entryPoint: NodeId | null; maxLevel: number }> {
    const result = await this.softDelete(targetNodeId, entryPoint, maxLevel);
    await this.context.hardDeleteNode(targetNodeId);
    return result;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * After deleting the entry point, pick a replacement from one of the former
   * neighbours at the highest available layer.
   *
   * NOTE: This method intentionally does NOT attempt to update `maxLevel`.
   * The maximum level is a graph-wide property that cannot be derived from a
   * single node's local neighbour list.  The caller (HNSWIndex.delete) is
   * responsible for recomputing the true global max level via the level
   * histogram (`graphStorage.computedMaxLevel()`).  We simply return the
   * passed-in value so that the contract makes sense even for callers that do
   * not have histogram access.
   */
  private async pickNewEntryPoint(
    deletedNode: HNSWNode,
    maxLevel: number,
  ): Promise<{ entryPoint: NodeId | null; maxLevel: number }> {
    // Walk from the highest layer downward to find a live neighbour.
    for (let layer = deletedNode.level; layer >= 0; layer--) {
      const neighbors = deletedNode.neighbors[layer] ?? [];
      for (const neighborId of neighbors) {
        try {
          const n = await this.context.getNode(neighborId);
          if (!n.deleted) {
            // Return this neighbour as the new entry point.
            // maxLevel is passed through unchanged — the true graph-wide
            // maximum is maintained by the caller via the level histogram.
            return { entryPoint: neighborId, maxLevel };
          }
        } catch {
          continue;
        }
      }
    }

    // Graph is empty (or all neighbours were also deleted).
    return { entryPoint: null, maxLevel: 0 };
  }
}
