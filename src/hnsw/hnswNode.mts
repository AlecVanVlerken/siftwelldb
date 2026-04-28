//@author: Thomas Dumon with usage of Claude sonnet 4.6
//@date: 2026-02-18

import type { VectorPointer } from './vectorHeapFile.mjs';

/**
 * A `NodeId` is a 53-bit safe integer that encodes the physical location of a
 * node on disk: the high bits encode the FBF block (page) number and the low
 * 32 bits encode the slot index within that page.
 *
 *   NodeId = pageId * 2^32 + slotId
 *
 * Encoding and decoding is handled by `encodeNodeId` / `decodeNodeId` in
 * `hnswGraphStorage.mts`.
 */
export type NodeId = number;

/**
 * HNSWNode
 * ---------
 * In-memory representation of a single node in the HNSW graph.
 * Instances are serialised to / deserialised from fixed-size slots in
 * `HNSWGraphStorage` pages.  All fields must be populated before calling
 * `graphStorage.insertNode()` or `graphStorage.saveNode()`.
 */
export class HNSWNode {
  /** Persistent disk location of this node (page << 32 | slot, as a safe integer). */
  nodeId!: NodeId;
  /** Block number of the document this node indexes in the RecordStore. */
  docId!: number;
  /** The HNSW layer this node was assigned to (0 = bottom layer). */
  level!: number;
  /** Location of the float32 vector in VectorHeapFile. */
  vectorPtr!: VectorPointer;
  /**
   * Adjacency lists per layer: `neighbors[layer]` is the list of NodeIds
   * connected to this node at that layer.  Layer 0 may hold up to 2*M
   * entries; upper layers hold up to M.
   */
  neighbors!: NodeId[][];
  /** True if this node has been soft-deleted; skipped during search. */
  deleted!: boolean;

  constructor(init?: Partial<HNSWNode>) {
    Object.assign(this, init);
  }
}
