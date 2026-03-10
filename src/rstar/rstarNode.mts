import { Rectangle } from './rstarRectangle.mjs';

/**
 * RStarEntry
 * ----------
 * Represents a single entry in an R*-tree node.
 *
 * For **leaf nodes**: Contains the MBR of an indexed object and its record ID.
 * For **internal nodes**: Contains the MBR of a child subtree and the child's page ID.
 */
export interface RStarEntry {
  /** Minimum bounding rectangle of this entry */
  mbr: Rectangle;
  /** Page ID of child node (internal nodes only) */
  child?: number;
  /** Record/document ID (leaf nodes only) */
  recordId?: number;
}

/**
 * RStarNode
 * ----------
 * In-memory representation of a single node in the R*-tree.
 *
 * **Node Types**
 * - **Leaf nodes** (level=0): Store actual data entries with record IDs
 * - **Internal nodes** (level>0): Store child pointers with their MBRs
 *
 * **Persistence**
 * Nodes are serialized to/from disk pages via `RStarTreeStorage`.
 * The `pageId` field tracks the on-disk location for updates.
 *
 * @example
 * const leaf = new RStarNode(0);  // Create a leaf node
 * leaf.entries.push({ mbr: rect, recordId: 42 });
 *
 * const internal = new RStarNode(1);  // Create internal node at level 1
 * internal.entries.push({ mbr: childMbr, child: childPageId });
 */
export class RStarNode {
  /** Tree level: 0 = leaf, higher = closer to root */
  level: number;
  /** Entries stored in this node */
  entries: RStarEntry[];
  /** On-disk page ID (set after allocation/loading) */
  pageId?: number;

  /**
   * Creates a new R*-tree node at the specified level.
   *
   * @param level - Tree level (0 for leaf nodes)
   */
  constructor(level: number) {
    this.level = level;
    this.entries = [];
  }

  /**
   * Checks if this node is a leaf node.
   * Leaf nodes store actual data entries; internal nodes store child pointers.
   *
   * @returns `true` if this is a leaf node (level === 0)
   */
  isLeaf(): boolean {
    return this.level === 0;
  }
}
