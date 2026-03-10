import { Rectangle } from './rstarRectangle.mjs';
import { RStarTreeStorage } from './rstarTreeStorage.mjs';

/**
 * Performs a range query on the R*-tree.
 *
 * Finds all indexed rectangles that intersect with the query rectangle.
 * Two rectangles intersect if they share any common area, including edges.
 *
 * **Algorithm**
 * - At each internal node: recurse into children whose MBRs intersect the query
 * - At leaf nodes: collect record IDs for entries whose MBRs intersect the query
 *
 * **Complexity**
 * - Best case: O(log n) when query is highly selective
 * - Worst case: O(n) when query covers entire space
 *
 * @param storage - The tree storage manager
 * @param nodePageId - Starting node page ID (typically the root)
 * @param query - Query rectangle to test intersection against
 * @param results - Output array to collect matching record IDs
 *
 * @example
 * const results: number[] = [];
 * await rstarSearch(storage, rootPageId, new Rectangle(0, 0, 100, 100), results);
 * // results now contains IDs of all rectangles intersecting the query
 */
export async function rstarSearch(
  storage: RStarTreeStorage,
  nodePageId: number,
  query: Rectangle,
  results: number[],
): Promise<void> {
  const node = await storage.loadNode(nodePageId);

  for (const entry of node.entries) {
    if (entry.mbr.intersects(query)) {
      if (node.isLeaf()) {
        // Found a matching record
        results.push(entry.recordId!);
      } else {
        // Recurse into child
        await rstarSearch(storage, entry.child!, query, results);
      }
    }
  }
}
